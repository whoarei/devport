# 实施进度与关键实现方法记录

> 对应设计文档：`00001_20260908_embedded-linux-remote-script-runner-design.md`
> 本文档持续更新，记录每个实施阶段完成了什么、怎么实现的、踩过的坑。
> 2026-09-08 代码审查后的修复、验证和当前限制见 [代码审查记录](00003_20260908_code-review.md)。串口 Shell V1 的实现记录见 [串口实现记录](00004_20260908_serial-shell.md)。以下阶段 1 方法为首次实现时的记录。

## 当前实现快照（2026-09-16，0.8.0）

阶段 1 章节是 2026-09-08 的历史快照，其中的目录、事件传递方式、编辑器和待办不再代表当前状态。本节依据当前源码、测试及 00004—00026 实施文档汇总；具体限制仍以对应专题文档和代码为准。

### 核心能力

| 领域 | 当前状态 | 边界 |
|---|---|---|
| 执行目标 | **已实现** SSH、Serial Shell V1、WSL、Local Shell | Serial 假定设备已进入 Linux shell；WSL 需要发行版内 Python 3.8+；Local 原地运行 |
| 脚本类型 | **已实现** Python、Shell、自定义命令 | 没有 Node / Binary 专用 `ScriptKind`；可由命令模式显式调用 |
| 控制台 | **已实现** xterm.js、stdin、Stop、超时 | SSH / WSL / Local 支持 pipe、PTY、resize；Serial 为合并输出的 PTY-like 模式且不能运行中 resize |
| 工作区同步 | **已实现** SSH SFTP、Serial 文本上传、WSL 二进制快照、Local 原地执行 | 每次运行全量处理；没有 hash / 增量同步；远端运行目录不自动回收 |
| 工作区文件管理 | **已实现** 递归目录树、读写、新建、重命名、删除和路径边界校验 | 仅编辑 UTF-8 普通文件，单文件上限 1 MiB；运行同步敏感阶段阻止变更 |
| 编辑器 | **已实现** CodeMirror 6、Python / Shell / text 高亮、保存、revision 冲突检测、多标签和未保存保护 | 无另存为、自动保存、草稿恢复、格式化、LSP、诊断和调试器 |
| 运行状态与历史 | **已实现** 活动任务、200 条历史、原始输出日志、记录/输出导出和清空 | 单次持久化输出上限 2 MiB；不恢复应用退出前仍在远端运行的进程 |
| 独立终端 | **已实现** SSH / WSL / Local 多标签终端，最多 8 个 | Serial 不支持独立终端；终端与 RunManager / 工作区相互独立 |
| 桌面集成 | **已实现** 托盘、关闭到托盘、开机自启、单实例、应用内更新 | updater 的签名发布和真实覆盖升级仍需发布环境验收 |
| 前端体验 | **已实现** 模块化 Dock / Panel 布局、最近工作区、预置命令、zh/en i18n、UI 缩放、Ctrl+Tab MRU | 持久化使用 localStorage；没有独立 Settings / Environment 页面 |

### 当前运行架构

```text
React / Zustand / CodeMirror / xterm
                ↓ Tauri invoke
commands.rs → RunManager → process.rs 共同状态与控制契约
                         ├── ssh/    （SFTP + exec channel）
                         ├── serial/ （nonce marker + 文本上传）
                         ├── wsl/    （wsl.exe + Python helper 协议）
                         └── local/  （portable-pty / pipes）
```

运行输出先进入后端有界 broadcast 队列，前端约每 33 ms 通过 `drain_run_events` 单飞行批量拉取；落后时收到 `resync` 状态快照并把跨缺口输出分段。它已取代阶段 1 的原生 `run-event` 直接推送方案。输出在边界上以 base64 保留原始字节。

持久化没有采用最初建议的 SQLite：设备、历史和运行日志由 Rust 写入应用配置目录中的 JSON / 日志文件；布局、语言、最近工作区和预置命令等 UI 偏好存入 localStorage。该选择与当前数据规模相符，但不提供数据库事务或跨实例共享；应用通过单实例机制避免并发写入。

### 已确认仍未实现

| 优先领域 | 未实现能力 | 现有替代或影响 |
|---|---|---|
| 环境管理 | Python venv、Node project environment、Managed Runtime、Runtime / Environment cache、Container mode | 当前依赖目标系统解释器或用户命令；无法保证不同设备的运行时一致性 |
| Artifact | 按 glob 收集、远端产物枚举/下载、Artifact 元数据 | 只能导出 Remote Runner 已记录的控制台输出；Local 产物因原地运行会直接留在工作区 |
| 同步与清理 | 增量同步、hash 缓存、SSH / Serial / WSL 运行目录自动清理 | 每次全量处理，远端目录可能累积；没有 CleanupManager |
| 执行模型 | Node / Binary 专用入口、`none` / `auto` console mode、项目级 `.devrunner/project.yaml` | 需使用 Command 模式并逐次填写参数 |
| 自动化 | Expect、Task Template、批量运行 | 预置命令只能启动单个 Command run，不是任务编排系统 |
| 设备协议 | Serial Device Agent、ADB / USB / WebSocket executor | Serial 仍受登录 shell、文本上传和 marker 协议边界限制 |
| 能力发现 | DeviceRuntimeProfile、动态 Capability Model | 当前只有按 transport 固定的 `pipe` / `resize` 两个能力位 |
| 安全 | 系统凭据库、SSH 证书认证、首次 host-key 指纹确认 UI | SSH 密码仍明文保存在 `devices.json`；支持 agent、普通私钥和密码，host key 当前为自动 TOFU |
| 生命周期 | 跨应用重启接管活动运行、远端孤儿进程发现 | 重启后只能看到已落盘终态历史，不能重新连接旧 ProcessSession |

这些项目按原设计并不都是下一版本承诺。若继续实现，优先级应由真实使用场景决定；其中系统凭据库和远端目录清理属于现有能力的安全/运维缺口，Runtime、Artifact、Agent 属于新增产品能力。

---

## 阶段 1（2026-09-08）：SSH-only MVP（历史记录）

### 本阶段范围（相比完整设计的裁剪）

| 项 | 状态 |
|---|---|
| 通信方式 | **仅 SSH**（russh + russh-sftp），串口/Agent 未实现 |
| 脚本类型 | **Python（.py）、Shell（.sh）、普通命令**；Node.js 暂不实现 |
| 运行环境 | 仅 System Runtime（远端 `python3` / `bash`）；venv / Managed Runtime 预留接口未实现 |
| PTY / pipe | 均已实现，用户可选，默认 pty |
| Run Console | xterm.js，语义为"远程进程"而非"远程 Shell" |
| 编辑器 | 等宽 textarea 只读预览（Monaco 与写回保存为后续工作） |
| Artifact 下载 / Expect / 增量同步 | 未实现 |
| Run History | 已实现（内存 + `history.json` 持久化，上限 200 条） |

### 工程结构

```text
remote_runner/
├── package.json / vite.config.ts / index.html
├── src/                        # React + TS 前端
│   ├── api.ts                  # invoke/event 封装 + 类型定义
│   ├── store.ts                # zustand 全局状态（设备/工作区/run/输出缓冲）
│   ├── App.tsx
│   └── components/
│       ├── DeviceDialog.tsx    # 添加/编辑/测试连接（模态框，经「文件」菜单打开）
│       ├── WorkspacePanel.tsx  # 本地工作区目录选择与文件列表
│       ├── Editor.tsx          # 脚本预览（只读 textarea）
│       ├── RunToolbar.tsx      # 设备选择、脚本/命令模式、参数、pty/pipe、超时、Run/Stop
│       ├── RunConsole.tsx      # xterm.js 控制台（输入回传、Ctrl+C、resize）
│       └── HistoryPanel.tsx    # 运行历史
└── src-tauri/src/              # Rust 后端
    ├── lib.rs                  # Tauri 装配：AppState、RunEvent→"run-event" 事件转发
    ├── commands.rs             # Tauri commands（Runner API）
    ├── device.rs               # DeviceProfile + devices.json 持久化
    ├── runner.rs               # RunManager（状态机/停止升级/超时/历史）
    ├── ssh/
    │   ├── client.rs           # 连接、认证（agent/私钥/密码）、host key TOFU
    │   ├── session.rs          # ProcessSession：exec channel + PTY + 控制通道
    │   └── filesync.rs         # SFTP 递归上传 + CRLF→LF 规范化
    └── bin/rr_cli.rs           # 无 GUI 链路验证工具（见"验证记录"）
```

### 关键实现方法

#### 1. Runner API（Tauri commands）

```text
list_devices / save_device / delete_device / test_device
list_workspace / read_workspace_file        # 带路径逃逸防护
run_script(request) -> run_id               # 前端只拿到 run_id
stop_run / send_run_input / resize_run_console
get_run_status / list_running_runs / get_run_history
```

流式输出走 Tauri Event：`run-event`，两种负载：

```text
{ type: "output", run_id, stream: "stdout"|"stderr", data: <base64> }
{ type: "status", status: RunStatus }
```

#### 2. SSH 认证顺序（AuthMethod::Key）

1. **ssh-agent 优先**：Windows 连接 `\\.\pipe\openssh-ssh-agent`（`AgentClient::connect_named_pipe`），
   Unix 走 `SSH_AUTH_SOCK`；枚举 agent 身份逐一 `authenticate_publickey_with`。
2. 本地私钥文件：`~/.ssh/id_ed25519` → `id_rsa` → `id_ecdsa`（或用户指定路径）。
3. AuthMethod::Password：密码认证。

Host key 采用 **TOFU**（Trust On First Use）：首次连接记录 SHA256 指纹到
`known_hosts.json`，再次连接校验；不一致则拒绝连接（日志记录）。

#### 3. 一次 Run 的执行流程（execute_inner）

```text
SSH 连接 → SFTP 全量上传 workspace 到 /tmp/devrunner/workspaces/<run_id>/
→ 构造包装命令 → exec channel（可选 PTY）spawn
→ 事件循环：转发输出 + 捕获远程 PID + 处理 stop/timeout
→ 结束：exited / canceled / failed，写入历史
```

#### 4. 包装命令（最关键的实现细节）

最终下发到 exec channel 的命令形如：

```bash
__f=/tmp/.devrunner-wrap-$$.sh; echo <base64> | base64 -d > $__f; exec 3<&0; \
setsid sh $__f <&3 & __pid=$!; printf '__DEVRUNNER_PID_%s__\n' "$__pid"; \
wait $__pid; __rc=$?; rm -f $__f; exit $__rc
```

其中 base64 解码后的脚本体（以 python 为例）：

```bash
cd '/tmp/devrunner/workspaces/<run_id>' &&  exec python3 -u 'test.py' 'arg1'
```

设计要点与原因：

- **base64 编码脚本体**：彻底避免多层嵌套引号转义问题（用户命令里可能含任意引号/`$`）。
- **先写临时文件再执行**：不能用 `echo b64 | base64 -d | sh` 直接喂——管道会抢占脚本进程的
  stdin，导致交互式脚本拿到的是 base64 流而不是用户输入。
- **`exec 3<&0` + `<&3`**：POSIX 规定非交互 shell 的后台任务 stdin 默认重定向到 `/dev/null`，
  必须先保存 channel 的 stdin 到 fd 3，再显式喂给后台脚本进程。否则 PTY 模式下
  `sys.stdin.isatty()` 为 False、`input()` 直接 EOF。
- **`exec python3 ...`**（脚本体内部）：让 `sh` 原地替换为目标进程，捕获到的 PID 就是
  python 进程本身，kill 精确。
- **`printf '__DEVRUNNER_PID_...__'`**：把后台进程 PID 打印到输出流，后端从 stdout 开头
  解析并剥离该标记（用户不可见）。这是 stop/timeout 能可靠杀进程的基础。
- **`wait $__pid`**：把被 kill 的退出码（如 143 = 128+SIGTERM）原样传回 channel exit-status。

#### 5. Stop / Timeout 的分级 kill

**坑**：实测该设备（OpenSSH 8.4p1）对 **非 PTY channel 的 signal 请求完全忽略**，
且进程不死时客户端发的 channel close 也得不到响应（用 paramiko 交叉验证确认是服务端行为，
不是 russh 的 bug）。因此不能依赖 SSH signal 请求来停止远程进程。

实际方案：

```text
stop/timeout 触发
  → 阶段1：PTY 模式发 0x03 字节（SIGINT 广播到前台进程组）；pipe 模式发 signal 请求（尽力而为）
  → 3s 后：kill -TERM -- -<pid>（pipe 模式进程组原子 kill）或 pkill -TERM -P + kill -TERM（pty）
  → 2s 后：同上，SIGKILL；同时本地发 channel close 双保险
  → 3s 后：服务端仍不关闭 channel，则本地强制结束 run（不阻塞 GUI）
```

- **pipe 模式包装层带 `setsid`**：脚本独立成进程组，PGID = PID，`kill -- -<pid>` 整组原子杀死，
  避免"先杀子进程后 sh 继续执行下一条命令"的竞态（实测 `sleep` 被杀后 sh 会抢跑执行后续命令）。
- **pty 模式不带 `setsid`**：setsid 会让进程失去控制终端，导致 `input()`/isatty 失效。
  pty 下 Ctrl+C 字节本身就能 SIGINT 整个前台进程组，树 kill 只是兜底。

#### 6. SFTP 上传的 CRLF 规范化

Windows 上编辑的脚本是 CRLF 行尾，`bash` 遇到 `\r` 会报
`exit: 3：需要数字参数` 这类错误。上传时对文本类扩展名
（sh/bash/py/txt/cfg/ini/yaml/yml/json/toml/csv/md/env 及无扩展名文件）自动做 CRLF→LF。
Python 本身兼容 CRLF，但统一处理更安全。

#### 7. russh 在 Windows 的加密后端

russh 默认 `aws-lc-rs` 在 Windows 构建需要 NASM（环境没有）。改用 ring 后端：

```toml
russh = { version = "0.63", default-features = false, features = ["ring", "flate2", "rsa"] }
```

#### 8. Vite dev server 绑定地址

Tauri CLI 探测 `http://localhost:1420` 走 IPv4，而 vite 默认可能只监听 IPv6 `[::1]`，
导致 `tauri dev` 一直 "Waiting for your frontend dev server"。
vite.config.ts 中显式 `server.host = "127.0.0.1"`。

### 验证记录（测试设备 root@172.16.0.67，aarch64，OpenSSH 8.4p1，Python 3.9.2）

无 GUI 验证工具 `rr-cli`（`cargo run --bin rr-cli`）：

```text
rr-cli command "uname -a && python3 --version"   → 输出正确，exit=0
rr-cli python hello.py a1 b2                      → stdout/stderr 分离正确，argv 正确，exit=0
rr-cli shell hello.sh world                       → 参数正确，exit=3 原样透传
rr-cli interact-test  # PTY + input() 自检        → isatty=True，stdin 输入正常，exit=0
rr-cli stop-test      # sleep 60 中途 stop        → canceled，exit=143，进程组无残留
```

### 阶段 1 待办的后续状态

- [x] 只读 textarea 已替换为 CodeMirror 6；保存写回、多标签、未保存保护和 revision 冲突检测已实现。项目没有采用 Monaco。
- [ ] 设备密码仍明文存于 `devices.json`，尚未迁移到系统凭据库。
- [ ] SSH / Serial / WSL 运行工作区仍不自动清理；Artifact 枚举与下载未实现。
- [x] pipe 模式使用独立进程组并分级停止；各传输的完整停止边界分别记录在 00004、00007、00023/00024。PTY 下任意复合命令及目标程序自行脱离会话后仍只能尽力停止，不能承诺回收所有 daemon 化后代。
- [ ] 2026-09-08 曾记录“首次连接偶发一次 run 不结束”，没有形成可复现用例或对应修复；现有自动化覆盖 TOFU 损坏/过期快照、SSH 拒绝与异常关闭，但不能据此宣称该历史现象已定位。
- [x] Serial Shell transport V1 已实现（端口枚举、8N1、marker 协议、文本工作区上传、stdin、停止与超时）；详见 00004。
- [x] WSL 直接执行、本机 Shell、独立终端、工作区文件管理、运行日志导出、更新、托盘/自启动、单实例、i18n、预置命令和模块化布局已实现；详见 00007—00026。
- [ ] Serial Agent、Node/Binary 专用入口、Python venv / Managed Runtime、Expect、增量同步仍未实现；完整清单见本文顶部“已确认仍未实现”。

### 运行方式

```powershell
npm install
npm run tauri dev    # 开发模式（自动重载）
npm run tauri build  # 打包
```

无 GUI 冒烟测试：`cd src-tauri; cargo run --bin rr-cli -- <command|python|shell|interact-test|stop-test> ...`

当前完整验证命令见仓库根目录 `AGENTS.md`：前端运行 `npm test`、`npm run build`；Rust 运行 `cargo fmt --all -- --check`、`cargo test --offline --all-targets`。WSL 真实发行版测试是显式 opt-in，物理串口与实际 SSH 设备不属于默认测试依赖。
