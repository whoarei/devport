# 本机 Shell 直连：实现细节

设计文档见 `00023_20260913_local-shell.md`。本文记录实现中的关键结构、已验证的平台行为与坑。

## 模块结构（src-tauri/src/local/）

- `shells.rs`：shell 注册表与探测。注册表条目 = `{ id, label, flavor, login, candidates }`；`Flavor` 决定 argv 构造（`Posix` / `PowerShell` / `Cmd`），`login` 只对 msys2/gitbash 为 true（`-l` 加载 /etc/profile 获得完整 PATH）。探测 = 按候选路径顺序找第一个存在的文件；Windows 候选含 PATH 查找 + 常见安装目录，Unix 为 `/bin/...` + PATH。`resolve()` 支持 `local.path` 自定义可执行文件覆盖（必须是已存在文件的绝对路径）。**Windows 的 PATH 查找不会去命中 `System32\bash.exe`**（注册表根本没有 Windows 版 bash 条目，msys2/gitbash 只用固定路径，天然规避 WSL 启动器）。
- `session.rs`：子进程会话层。PTY 走 `portable-pty`（Windows ConPTY / Unix openpty+forkpty），pipe 走 `std::process` + `CREATE_NO_WINDOW`（Unix 另加 `pre_exec(setsid)`）。IO 全部用阻塞线程 + 有界 `tokio::sync::mpsc` 队列回报 `ChildEvent::{Output, ReaderDone}`，高吞吐输出会在读取线程施加背压；stdin 经独立 writer 线程 + `std::sync::mpsc` 写入。退出检测不用 wait 线程，由执行循环每 50 ms `try_wait()` 轮询 —— 这样 `Child` 所有权不出会话，kill 与 wait 不需要跨线程共享。`Drop` 兜底：会话丢失时若子进程仍在运行则强制终止，不留孤儿。
- `mod.rs`：`invocation()`（按风味构造 argv）、`profile_args()`（唯一的 PowerShell profile 开关出口，见 00030）、`probe_args()`（连接测试命令行，与运行共用开关）、`execute()`（运行主循环）、`test_device()`（版本探测）。
- `terminal.rs`：独立终端标签，复用同一 Session，启动交互式登录 shell（posix `-li`/`-i`，pwsh/powershell 按 `no_profile` 决定 `-NoProfile`，cmd 无参数）。`execute()` 接受可选 cwd：未给定时回退 `default_working_directory()`；给定（工作区终端）但已不存在时打开失败，不静默落回默认目录。
- `verbatim.rs`：把 `canonicalize` 产生的 Windows verbatim 路径还原成常规形式（`\\?\D:\a` → `D:\a`、`\\?\UNC\srv\share` → `\\srv\share`），供 shell cwd 与运行请求使用；设备路径（`Volume{GUID}`、`GLOBALROOT`）、达到 MAX_PATH、以及去掉前缀会改变含义的路径（尾随点/空格、DOS 保留名）一律原样返回。

## 执行循环与停止升级

`execute()` 与 `RunManager::await_transport` 的契约同 WSL：用户停止（含控制台 Ctrl+C → `send_input([3])` → `stop()`）经 control 通道送达 `SessionControl::Interrupt`；超时由循环内 deadline 触发。升级节奏 INT → 3 s → TERM → 2 s → KILL → 3 s → 放弃等待（按当前停止原因收尾，避免不可杀进程把 run 卡死）。

平台映射：

- Interrupt：PTY 写 `0x03`（Unix 终端驱动 / ConPTY 分别转成 SIGINT / Ctrl+C）；pipe-Unix 对进程组发 SIGINT；**pipe-Windows 无等价语义，`interrupt()` 返回 false，直接进入 Terminate**。
- Terminate：Unix `SIGTERM` 进程组；Windows 与 Kill 相同（无跨进程温和终止）。
- Kill：Unix `SIGKILL` 进程组（pipe 的 setsid / PTY 的 forkpty 都保证子进程 pid == pgid）；Windows 用系统 `taskkill.exe /PID <pid> /T /F` 杀整棵树，再补 `child.kill()`。

退出判定只认 `try_wait()` 观察到的子进程退出；输出通道 EOF 不是成功信号。观察到退出后按 `expected_readers`（pty=1、pipe=2）等待读取线程 EOF 排空输出，宽限 300 ms；停止/超时路径额外无条件 `force_kill()` 一次以清理同组后代。

## 已验证的平台行为（踩坑记录）

### ConPTY 启动 DSR 握手（关键）

`portable-pty` 以 `PSEUDOCONSOLE_WIN32_INPUT_MODE` 创建 ConPTY。该模式下 **ConPTY 启动时向输出写入 `\x1b[6n`（DSR 光标位置查询）并等待回复，未收到回复前子进程实际上不推进**——实测 `cmd /C echo` 与 `pwsh -Command echo` 均永久挂起，kill 后只能读到那 4 字节查询。

解法：Windows 上 `session.rs` 的 PTY 读取线程扫描输出流（保留 3 字节跨块上下文），对首次 `\x1b[6n` 通过 stdin writer 通道代答初始光标位置 `\x1b[1;1R`。这里必须回复光标位置，不能把初始 PTY 的行列尺寸（默认 `80×24`）当成光标坐标，否则前端稍后将终端调整到更高高度时，pwsh/msys2 的提示符会出现在中部。代答仅启用在 ConPTY 且只发生一次，避免 Unix PTY 或应用后续主动查询光标位置时注入伪响应。实测代答后 cmd/pwsh 立即继续执行并正常退出。

### cmd 的 CRT 引号转义破坏内嵌双引号

`Command` 类型的 cmd 命令以 `cmd /C <command>` 单参数传递。Rust/portable-pty 按 CRT 规则拼命令行，命令串内嵌的 `"` 会被转成 `\"`，而 cmd.exe 不按 CRT 规则解析自身参数 → 内嵌双引号的 cmd 命令会损坏。无内嵌引号的命令（含 `&`、`()`、管道）均正常：`cmd /C` 对"首尾引号剥离"的条件判断在实践中覆盖常见形态。已在设计文档中声明为已知边界；测试里 cmd 的 stdin 验证因此用 `set /p v=& if defined v (exit 42) else (exit 41)`（`if defined` 在执行期判定，绕开 `%v%` 解析期展开问题；`!v!` 延迟展开在 `cmd /C` 单行中不可用）。

### PowerShell profile 提供的 PATH 不在注册表里

`portable-pty` 在 Windows 上重建子进程环境块时会**用注册表的 PATH 覆盖进程 PATH**（HKLM 系统 PATH + HKCU 用户 PATH 拼接），因此注册表里的 PATH 一直正常。但 fnm（以及 nvm、conda 等）不写注册表 PATH，而是由 profile 注入：`fnm env --use-on-cd` 会给每个 shell 生成独立目录 `%LOCALAPPDATA%\fnm_multishells\<pid>_<ts>\` 并前插到 PATH，npm 全局命令（`opencode`、`node`、`npm`）都在其中。于是 `-NoProfile` 会让这些命令在应用内不可见、在 Windows Terminal 里正常——同一台机器、同一个 shell，差别只在是否加载 profile。实测：`pwsh -NoProfile -Command Get-Command node` → 找不到；带 profile → 解析到 `fnm_multishells\...`。结论：profile 是否加载必须是一个显式开关而不是各入口各自硬编码（`local.no_profile`，见 00030）。

### pipe 模式 stdin 的 EOF 语义

`more`/`cat` 这类读到 EOF 才退出的程序会一直等待 —— 本会话为支持交互输入不会主动关闭 stdin。测试 stdin 可达性必须用"读一行就继续"的负载。这是预期行为，非缺陷。

## 工作区与环境

原地运行：有工作区时 `cwd = RunRequest.workspace_dir`（`validate_request` 已 canonicalize 并校验入口 containment，回写请求前用 `verbatim::simplify` 还原成常规形式）；无工作区命令与独立终端以本机用户目录为 cwd，并在无法解析用户目录时回退应用当前目录。工作区终端例外：`open_workspace_terminal` 命令经 `workspace::terminal_dir` 把 subdir 解析为 canonical 目录（与 `list_dir` 同一套校验）后同样还原成常规形式，仅 Local 设备可用，其他 transport 传 cwd 一律拒绝。msys2/gitbash 以登录 shell 运行（`-l` 加载 /etc/profile 获得完整 PATH），run 与终端两条路径都会注入 `CHERE_INVOKING=1`（`preserve_cwd_env`，用户显式给出的同名变量优先），阻止 /etc/profile `cd $HOME` 覆盖 spawn cwd；msys shell 不识别盘符路径，Shell 入口仍转成 `/e/...` posix 形式（`to_msys_path`）。环境变量通过进程环境块注入（`CommandBuilder::env` / `Command::envs`），不生成 `export` 前缀，无 shell 注入面。Python/Shell 类型直接 spawn 解释器/脚本，参数不经 shell 解释；Python 解释器在 PATH 中解析（Windows `python` → `python3`，Unix 反之）。

## 测试

本机 shell 测试全部无硬件依赖，真实 shell 缺失时自动跳过：

- 纯构造：三种风味的 Command argv、Python/Shell 入口拼接、默认工作目录、msys 路径转换；device 层 local 配置校验（device.rs 测试）。
- 集成（fallback shell = Windows cmd / Unix sh）：pipe 模式 stdout/stderr 分流与非零退出码、PTY 合并输出、stdin 可达（退出码 42 判定）、用户停止升级取消长任务、运行超时、PTY resize 与 Ctrl+C 中断。
- `every_detected_shell_runs_echo`：对本机探测到的每个 shell（本机实测覆盖 pwsh、powershell、cmd、msys2、gitbash）各跑一次 echo。
- `test_device_reports_shell_version`：版本探测输出。
- `session.rs` 单元测试：ConPTY DSR 代答只响应首次启动查询。

验证命令：`cargo test --offline --lib local::`（全量见 AGENTS.md）。曾被挂起杀死的测试进程可能留下孤儿 conhost/OpenConsole，按启动时间甄别清理。
