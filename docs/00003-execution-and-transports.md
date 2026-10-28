# 00003 运行与传输协议

基线：2026-10-20 / 0.12.0。上层见 [技术方案](00002-architecture.html#execution)，工作区处理见 [00004](00004-workspace-and-sync.md)。

## 1. 运行入口与提交快照

工作区脚本使用 `run_workspace`，预置 Shell 命令和 SSH smoke-test CLI 保留 `run_script` 兼容入口。不要把旧请求中的 `ScriptKind::Shell` 各 Shell 脚本兼容能力，等同于新工作区入口的 Bash 语义。

`workspace_run::Request` 的核心组成：

| 字段 | 语义 |
| --- | --- |
| `workspace` | 来源 `WorkspaceRef`，本机目录或 SSH / WSL 设备目录 |
| `device_id` / `device_revision` | 目标配置及其修订；不匹配则拒绝本次提交 |
| `config_revision` | 已读取的源 `.runner/config.json` 修订；显式会话设置可不携带 |
| `command` | 结构化入口与原始 `args: string[]` |
| `python` | `device_default` 或 `project`，仅 Python 入口消费 |
| `settings` | `cwd`、附加 `env`、PTY / pipe、超时、行列数、可选 Bash 选择 |
| `source` | 历史菜单的文件/目录来源索引，不参与命令执行身份 |
| `operation` | `run`、`prepare`、`rebuild`；后两者仅用于项目 Python |

入口为带标签联合：`bash_script {path}`、`python_script {path}`、`python_module {name}`。脚本以工作区根定位，`cwd` 单独解析为工作区内目录；模块名按 ASCII Python 标识符分段校验。命令序列化后最多 60 KiB，参数拒绝 NUL，空字符串参数仍是一项，不能拆成 Shell 文本再解析。

提交次序：捕获入口和源工作区代次 → 保存全部脏标签 → 复查工作区及源宿主连接修订 → 从同一份同步状态读取目标、修订、Python 选择和所有设置 → 后端校验并冻结配置 → 准备源码和解释器 → 复查实际使用的项目输入 → 启动 → 成功启动后记忆源端命令。

保存期间切目标，使用保存结束时的一整份目标设置；保存期间切工作区或源连接，中止启动。快照形成后切换 UI 不影响已提交任务。重新运行只复用入口和参数，采用当前设置；源工作区不匹配、上下文未知时禁用。

后端派生的解释器路径、源码路径和环境上下文不允许由客户端反序列化回填。`workspace_commands.rs` 负责新 IPC 适配，`runner.rs` 仍承担实际调度，不能在文档中假定存在一个尚未落地的独立通用 Executor 框架。

## 2. 状态与输出

```text
preparing → syncing → starting → running → exited
     └────────────── stopping ────────────→ canceled
任意阶段遇到错误 → failed
```

部分路径省略同步阶段；准备操作可以不启动用户脚本。实际枚举只有 `preparing / syncing / starting / running / stopping / exited / failed / canceled`。正常进程退出使用 `exited` 并保留退出码，非零退出码也不自动改成 `failed`；用户停止完成为 `canceled`，超时为 `failed` 加错误原因。没有独立 `stopped` 或 `timeout` 状态。

`RunStatus` 的 `phase` 表达 Python 准备子阶段，`waiting_workspace` 表达目录等待，`workspace_sync` 表达实际路径和差异统计。不要将这些信息伪造为用户脚本输出。后端生成的环境准备诊断另进入运行日志，见 00005。

原始输出字节 → 16 KiB 分片 → Base64 `RunEvent::Output` → 容量 256 的 broadcast → 每次最多拉取 64 个事件 → 前端解码为 `Uint8Array` → xterm。拉取约 33 ms 一次且保持单飞行；生产过快时发送 `resync` 状态快照，并保留窗口内近期输出，不承诺补齐所有丢失输出。

前端单任务最多 2 MiB / 4096 块，总计 16 MiB，淘汰较旧块；后端 `run_logs/<run_id>.log` 最多保留开头 2 MiB。两者的保留方向不同。输出缺口重置回放边界，不能将缺口两侧的半个 UTF-8 或 ANSI 序列拼接。重启快照不恢复控制台输出或进程，磁盘日志也不等于现有 UI 提供日志导入或导出接口。

## 3. 输入、中断、停止与超时

| 操作 | 行为 |
| --- | --- |
| 普通输入 | Base64 解码后转为会话字节输入；只向对应任务传递 |
| Ctrl+C，有选区 | 默认复制选择内容；关闭“Ctrl+C 复制选区”后发送一次中断 |
| Ctrl+C，无选区 | 一次 `SessionControl::Interrupt`；键盘长按重复事件忽略，不触发停止升级 |
| Ctrl+V | 默认粘贴；关闭“Ctrl+V 粘贴”后交给终端程序 |
| Ctrl+Shift+C / Ctrl+Shift+V | 始终复制 / 粘贴；空选区复制不操作 |
| 停止按钮 | `stop_run`，取消准备或进入传输自身的停止流程，清理排队输入 |
| 超时 | 进入停止处理，终态以 `failed` 和超时原因表示 |
| resize | SSH / WSL / Local 支持，Serial 启动后明确拒绝 |

SSH / WSL / Local 运行阶段采用 INT → TERM → KILL 升级；具体计时和退出排空由会话实现管理。Windows Local pipe 不支持温和单次中断：Ctrl+C 明确报错且任务继续；停止依靠 `taskkill /T /F`。用户程序可以捕获单次 Ctrl+C 后继续运行，因此不能以“发送成功”推断退出。

剪贴板开关位于“设置 → 终端”，默认均开启，独立终端与运行控制台统一即时生效；详见 [客户端状态与恢复](00007-state-and-recovery.md)。

## 4. SSH

- `russh` 连接，SFTP 文件通道；支持 PTY 或独立 stdout/stderr pipe、stdin、resize。
- 密钥认证先尝试 ssh-agent，再尝试配置路径或默认 `id_ed25519` / `id_rsa`；也支持密码。
- `known_hosts.json` 按 `host:port` 保存 SHA-256 指纹：首次自动信任，后续变更拒绝，损坏记录拒绝连接且不覆盖；不支持 SSH 主机证书。
- 包装脚本逐参数严格引用，使用 PID / 进程组控制停止。pipe 单次 SIGINT 在 PID 标记就绪后发送；PTY 传递终端中断。
- 已认证连接可在同一次运行内供同步、探测和执行复用，各自使用独立 channel；不借用单槽编辑连接。
- 正常退出确认与连接关闭分开处理。未确认远端退出时保留同步目录租约，不能因本地会话结束就解锁。

SSH 本身不要求目标装 Python；设备默认 Python 运行需要解释器，项目模式可部署它。Shell / 工作区功能需要目标具备对应 Linux/POSIX 工具及 SFTP 能力。安全增量发布要求服务端支持 `hardlink@openssh.com` 和 `posix-rename@openssh.com`，缺少时明确失败。

## 5. Serial Shell V1

任务运行和连接测试依赖已经登录的 Linux Shell。默认 115200、8N1、无流控，波特率合法范围 1–4,000,000。数据位可选 5/6/7/8，校验位可选无/奇/偶，停止位可选 1/2，流控可选无、软件 XON/XOFF 或硬件 RTS/CTS；旧配置缺少这些字段时沿用默认值。Rust 边界校验全部参数，终端、任务运行和连接测试共用串口打开配置；设备端的串口参数需与之匹配。打开前获取进程内端口租约，再申请系统 exclusive；所有失败与完成路径释放租约。独立终端、任务运行和连接测试共享租约，同一端口（含不同设备配置引用的同一端口）互斥，不同端口可并行。

设备设置提供常用波特率下拉选项，也可选择“自定义波特率”输入范围内的整数；已有自定义数值在重新编辑时保留。

```text
RS RR_<nonce>_B US
<进程原始输出>
RS RR_<nonce>_E:<exit-code> US
```

`RS=0x1e`、`US=0x1f`。字节解析器支持标记跨包，只认本次 nonce，剥离提示符、回显和 framing。提示符、EOF、断线均不代表成功。启动前保存/设置 termios，退出恢复；启动失败可由标记返回 125。

单一合并输出流，强制 PTY 语义；启动时 `stty` 设置尺寸，之后不支持 resize。Ctrl+C 单次只发 `0x03`；停止按钮清空待发输入并发 Ctrl+C，5 秒仍无结束标记则失败并报告远端状态未知。半条命令发送后取消也不能仅凭本地写成功报告已停止。

上传为 UTF-8 无 NUL 文本，CRLF → LF，每块最多 3 KiB，base64 + 引号 heredoc，每块确认成功才继续。空文件也创建/截断。单文件 1 MiB、总计 8 MiB、1024 条目、相对路径 512 字节；拒绝链接、重解析点和特殊文件。包装命令最多 16 KiB，物理行最多 2048 字节，除换行外拒绝原始 ASCII 控制字符；端口打开前预检全部命令。块开始响应考虑波特率发送耗时，块执行超时 30 秒。

独立串口终端直接透传原始字节，不注入探测、登录、任务包装或 `stty` 命令，不解析或剥离 nonce 标记、提示符和回显，可手动输入登录凭据。Ctrl+C 只透传用户输入的 `0x03`；窗口行列数仅影响本机显示，不发送远端 resize。打开端口后即标记连接成功，不表示设备 Shell 已就绪。

关闭标签、关闭全部终端或应用退出时，仅取消读写并关闭串口句柄，之后释放端口租约；不发送 Ctrl+C、`exit` 或其他清理命令，不等待未发送输入排空，也不承诺远端程序退出。设备断线/EOF 和读写错误将会话标记失败，远端进程状态未知，不生成成功退出码。连接失败、输出超限和所有关闭路径都释放串口；重连使用当前设备配置重新获取租约，不重放输入。

Serial 不承载设备工作区、二进制文件传输或 uv 环境。任务运行中，进程和登录 Shell 共用输入通道，退出标记在途时存在输入落到 Shell 的窗口；严格隔离需要另一种协议。测试采用 Tokio duplex 与本机 POSIX/Git Bash，无物理串口依赖。

## 6. WSL

仅 Windows 桌面通过结构化 `wsl.exe` 参数选择发行版和可选用户。发行版需预装 Python 3.8+；用户留空使用发行版默认用户。Python helper 源码先经 stdin 以 Base64 下发，命令行只含短 bootstrap，必须保留命令行长度回归，避免 Windows 32767 字符限制。

helper 使用单独的结构化控制消息管理 PTY / pipe、stdin、resize、Interrupt、进程组停止与文件服务。路径、文件内容、发行版、用户名不拼入动态 Shell 文本。只有显式完成消息确认执行结束，EOF 是失败；禁止用终止整个发行版来停止任务。

编辑使用 `fs_*`，传输/同步使用 `tf_*` 安全文件消息。长运行命令可以使用独立 helper，以免阻塞环境锁心跳。文件操作使用 dirfd + `O_NOFOLLOW`，cwd 单独逐级检查；helper 中多次 exec 必须重置完成状态。设备项目环境不能替代连接 helper 对预装 Python 的要求。

## 7. Local Shell

Windows 探测 pwsh、Windows PowerShell、cmd、MSYS2、Git Bash；macOS/Linux 探测 bash、zsh、sh，可配置可执行路径。本机工作区原地执行；跨设备暂存到本机则执行暂存副本，结束清理，见 00004。

`portable-pty` 使用 ConPTY/openpty，pipe 使用独立管道和线程 IO。ConPTY 启动 DSR 查询 `ESC[6n` 由后端读线程应答，避免启动挂起；Windows 子进程避免额外可见窗口。

`LocalConfig.no_profile` 是 PowerShell profile 的唯一开关，默认加载。交互终端、命令、脚本和探测均经 `local::profile_args`；fnm/nvm/conda 等 profile PATH 由此进入解析上下文。工作区 Python 先在该上下文探测绝对解释器和完整环境，再直接启动；附加 env 最后覆盖，Windows 处理变量名大小写和显式空值。

命令按 Shell 风味解释：PowerShell `-Command`、cmd `/C`、POSIX `-c`，MSYS2/Git Bash 加登录环境并尽量保留 cwd。新工作区 `.sh` 使用实际 Bash，不能交给 PowerShell/cmd；多候选要求明确选择。临时脚本保持 argv 边界并避开长命令行，退出清理。

传给 Shell 的 Windows 路径必须经 `verbatim::simplify`，不能使用原始 `canonicalize` 的 verbatim 路径。Python 探测取消/超时使用 Windows Job Object 或 Unix 进程组回收后代。真实本机测试不能代替所有 Windows CPython/ConPTY 输入时序的人工验证。

## 8. 源码与验证入口

- [IPC 与类型](../src/api.ts)、[新工作区 IPC](../src-tauri/src/workspace_commands.rs)、[RunManager](../src-tauri/src/runner.rs)、[公共控制类型](../src-tauri/src/process.rs)、[事件缓冲](../src-tauri/src/events.rs)。
- [SSH 会话](../src-tauri/src/ssh/session.rs)、[串口 framing](../src-tauri/src/serial/protocol.rs)、[WSL helper](../src-tauri/src/wsl/helper.py)、[Local 会话](../src-tauri/src/local/session.rs)。
- 自动化覆盖参数保真、状态、取消升级、EOF 失败、端口释放、DSR、原始字节、背压。实际命令与硬件验证边界见 [00008](00008-development-and-release.md)。
