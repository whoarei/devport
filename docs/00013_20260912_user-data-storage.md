# 用户数据存储设计

本文整理 Remote Runner 当前版本（0.4.x）的用户数据存储设计：存什么、存哪里、以什么格式存、有哪些写入与保护机制。

## 总览

数据分为四类：

| 类别 | 位置 | 说明 |
| --- | --- | --- |
| 应用配置目录 | Tauri `app_config_dir`（Windows：`%APPDATA%\com.devrunner.remote-runner`） | 设备列表、运行历史、文件传输历史与检查点、SSH 主机密钥信任库 |
| 浏览器 localStorage | WebView 内 | 界面布局、最近打开的工作区（本机目录或设备目录，见 00029）、本机与各设备上次打开的文件传输目录 |
| 用户自选工作区目录 | 本地磁盘任意位置（目录选择对话框），或某台 SSH/WSL 设备上的目录（00029） | 脚本文件本体，应用不复制、不索引 |
| 运行时内存状态 | 进程内存（Zustand store / Rust 状态） | 运行草稿、输出缓冲、终端会话等，不持久化 |

配置目录在应用启动时解析并创建（`src-tauri/src/lib.rs`），解析失败时回退到 `dirs::config_dir()/remote-runner`。`rr-cli` 同样使用该目录。

## 应用配置目录

### devices.json — 设备配置

由 `DeviceStore`（`src-tauri/src/device.rs`）管理，内容为 `Vec<DeviceProfile>` 的 pretty JSON 数组。每条记录字段：

| 字段 | 说明 |
| --- | --- |
| `id` | UUID，保存时为空则自动生成 |
| `name` | 显示名称（必填） |
| `transport` | `ssh` / `serial` / `wsl`，缺省 `ssh`（兼容旧配置） |
| `host` / `port` / `username` | SSH 连接参数，`port` 缺省 22 |
| `auth` | SSH 认证：`{ "type": "password", "password": ... }` 或 `{ "type": "key", "key_path": ... }`（`key_path` 为空时依次尝试 `~/.ssh/id_ed25519`、`id_rsa`） |
| `serial` | `{ "port": "COM8", "baud_rate": 115200 }`，波特率缺省 115200，合法范围 1–4000000 |
| `wsl` | `{ "distribution": "Ubuntu-24.04", "user": "" }`，`user` 为空表示发行版默认用户 |
| `workspace_root` | 远端工作区根目录，缺省 `~/devrunner/workspaces`，支持绝对 Linux 路径或 `~/` 前缀，均不可含 `.`/`..` 分量；已有配置中的显式路径保持不变 |

写入路径上的校验在 Rust 边界完成（`DeviceProfile::validate`）：所有保存（包括前端命令和 CLI）都经过同一校验；`write_all` 先确保父目录存在再整体重写文件（非原子写，失败可能截断——当前可接受，文件极小）。

`~/` 表示目标设备当前用户的主目录，不按用户名猜测 `/home/<user>`：SSH 通过 SFTP 初始目录解析，WSL 由所选发行版和用户的 helper 握手提供，串口在已登录的 shell 中通过 nonce 标记协议读取 `$HOME`。运行上传、托管环境重建和文件传输在访问文件前将其展开为绝对路径；设备工作区本身仍只接受绝对路径。

> **安全注意（已知 TODO）**：`AuthMethod::Password` 目前以**明文**保存在 `devices.json` 中（代码注释中标注为安全设计 TODO）。`known_hosts.json` 与设备配置均无加密、无系统钥匙串集成。

### history.json — 运行历史

由 `RunManager`（`src-tauri/src/runner.rs`）管理。每次运行进入终态（exited/failed/stopped/timeout）时：

1. 将 `RunStatus` 推到内存双端队列头部；
2. 超出 `HISTORY_LIMIT = 200` 条时从尾部丢弃；
3. 整体序列化为 pretty JSON 写回 `history.json`（写入失败仅忽略，不影响运行）。

启动时读取该文件恢复历史，解析失败则按空历史启动，并截断到上限。每条 `RunStatus` 包含：

- `run_id`：UUID；
- `device_name`：运行时的设备显示名（快照，不随设备改名变化）；
- `label`：运行标签（入口文件或命令摘要）；
- `state`：`preparing` / `syncing` / `starting` / `running` / `stopping` / `exited` / `failed` / `stopped` / `timeout`；
- `exit_code`、`error`：终态结果；
- `started_at` / `ended_at`：本地时区 RFC 3339 时间戳；
- `output_bytes` / `output_truncated`：已持久化输出的字节数与截断标记（0.4.x 之前的历史条目缺省为 0/false）。

### run_logs/ — 运行输出日志

每次运行的输出（原始字节，stdout/stderr 按到达顺序合并）在推送前端事件的同时追加写入 `run_logs/<run_id>.log`，单个 run 上限 2 MiB，超限截断并在 `output_truncated` 中标记；写入失败仅放弃该 run 的落盘，不影响运行。日志随历史淘汰删除（`finish()` 淘汰、启动截断、孤儿文件清理），最坏磁盘占用约 200 × 2 MiB = 400 MB。历史面板右键可将记录元数据导出为 JSON、将输出日志原样复制到用户选择的路径。

### transfers.json / transfer-journal/ — 文件传输历史与检查点

文件传输（`src-tauri/src/file_transfer/`，方案 `00033_20261012_file-transfer-plan.md`）独立保存任务端点、选择、同名策略、条目结果、统计、错误与准确的待清理临时名称，不保存文件内容或认证凭据。

`transfers.json` 在注册和终态时通过临时文件替换写入；活动任务的逐文件结果、提交前状态和清理变化追加到 `transfer-journal/<task_id>.jsonl` 并同步到磁盘，避免大批量小文件逐次重写全部历史。启动时回放更新的检查点，忽略已被主文件合并的旧序号及不完整尾行；未结束任务恢复为「已中断」，提交确认不明的条目标记 `unknown`，不自动续传。

历史最多保留最近 100 个任务，启动时筛掉 7 天以前的普通记录，未清理记录不按普通历史淘汰；在活动 / 残留占满预算时拒绝新的任务。本机与各 SSH / WSL 设备上次成功打开的浏览目录分别保存到 localStorage，选中项只保留于会话；面板显隐 / 折叠沿用 `remote-runner.layout.v1`。

### known_hosts.json — SSH 主机密钥信任库

简化版 known_hosts，TOFU 语义（`src-tauri/src/ssh/client.rs`）：内容为 `HashMap<"host:port", SHA256 指纹>` 的 JSON 对象。

- 首次连接某地址：信任并把指纹写入文件；
- 再次连接：指纹一致放行，不一致返回 `HostKeyMismatch` 拒绝连接；
- 文件损坏时拒绝连接且**不覆盖**原文件（防止陈旧连接清掉信任记录）；
- 所有连接在进程级 `KNOWN_HOSTS_LOCK` 下读写同一信任库。

仅保存 SHA256 指纹，不保存公钥本体；不支持证书认证（直接拒绝）。

## 前端 localStorage

WebView 的 localStorage 使用带版本后缀的键保存界面偏好：

| 键 | 内容 | 上限 |
| --- | --- | --- |
| `remote-runner.layout.v1` | 界面布局：工作区/历史/控制台三个面板的显隐与折叠、编辑区折叠、侧栏宽度（200–480 px）与左右位置、侧栏上下分割比（0.2–0.8）、控制台高度（120–720 px） | 单对象 |
| `remote-runner.recent-workspaces.v2` | 最近打开的工作区（`WorkspaceRef` 对象数组：`{type:"local",dir}` 或 `{type:"device",device_id,path}`，去重、保留首次出现顺序） | 10 条 |
| `remote-runner.recent-workspaces.v1` | v2 之前的旧键（裸路径字符串数组）；读取时迁移到 v2 并删除本键 | 迁移后不再写入 |
| `remote-runner.ui-zoom.v1` | 整个 WebView 的界面缩放百分比；允许 70%–200% 的预设档位 | 单个数值 |
| `remote-runner.transfer-directories.v1` | 文件传输目录：本机目录 `local`，按设备 ID 保存的目录映射 `devices`；只记录成功打开后的返回路径，不保存文件选择或凭据 | 本机一条，每设备一条 |

这些偏好都有防御性读取：坏数据、缺字段、越界值会回落到默认值；写入失败不会中断应用。文件传输切换设备时恢复对应目录，首次使用设备回落到其工作区根目录；设备改名保留记忆，新设备 ID 不复用旧目录。从工作区右键进入时优先采用指定工作区和条目位置。恢复目录失败时保留地址供修改，不覆盖此前成功打开的记忆。localStorage 属于 WebView 数据目录，与应用配置目录不是同一位置，清除 WebView 数据不影响设备配置与运行历史。

## 用户工作区目录

脚本文件本体存储在用户选定的目录中：本机任意目录（目录选择对话框），或某台 SSH/WSL 设备上的目录（「打开设备工作区…」，见 `docs/00029_20260917_remote-workspace.md`）。应用**不在配置目录里保存副本**。

本机工作区的约束在 `src-tauri/src/workspace.rs`：

以下约束针对编辑器的工作区命令；独立文件传输和外部进程不共享编辑器互斥锁，也不提供运行源目录的原子快照。传输中的源文件 / 目标文件变化检查及并发边界见 `00033_20261012_file-transfer-plan.md`。

- 仅 UTF-8 文本、单文件上限 1 MiB；记录 `revision`（内容 SHA-256 摘要）、`eol`（lf/crlf）、`bom` 用于乐观并发保存；
- 拒绝符号链接/重解析点路径（含工作区根的祖先目录），只允许普通文件与目录；
- 所有写操作持有进程级 `FILE_OPERATIONS` 互斥锁；任意运行处于准备/同步/停止阶段时，工作区修改被整体拒绝（`blocked_by_run`），保证传输层扫描的目录不会同时被改动；
- 写入采用临时文件替换方式，冲突（sharing violation）时保留原文件并清理临时文件。

设备工作区的约束在 `src-tauri/src/remote_workspace/`：SSH 经 SFTP（工作区根 canonicalize 一次，根以下逐级 LSTAT 拒绝链接），WSL 经 helper 的 `fs_*` 文件服务（dirfd + `O_NOFOLLOW` 约束在工作区根内）；两者同样有 1 MiB 编辑器上限、写入前 revision 校验与原子替换。

运行时的文件放置分三种情况：

- 运行目标为工作区所在设备 → **原地运行**，不复制任何文件，产物留在工作区；
- 运行目标为其他设备（含本机）→ 先把源工作区下载到本机暂存目录 `%TEMP%\remote-runner-stage-<run_id>`，再按传输方式上传到远端 `{workspace_root}/{run_id}`（默认如 `/home/user/devrunner/workspaces/<uuid>`）；**暂存目录在运行结束（无论成败）时清理**；
- 远端 `{workspace_root}/{run_id}` **在运行结束后不清理**，保留在设备上，由设备默认 `workspace_root` 集中存放。

## 不持久化的运行时状态

以下内容只存在于内存，应用退出即丢失：

- 前端 Zustand store：设备选中项、当前打开文件与编辑内容、运行草稿（`RunDraft`：模式/入口/参数/命令/控制台模式/超时）、每个 run 的输出缓冲（有总量上限 `MAX_TOTAL_OUTPUT_BYTES`，仅用于控制台回看；输出本体另持久化在 `run_logs/`）、活动 run 与控制台尺寸；
- 终端会话（`TerminalManager`）：独立 SSH/WSL 终端的会话句柄与输出，关闭标签或应用即销毁；
- 更新状态（`UpdateState`）：下载进度、更新互斥门（更新期间禁止启动运行），不落盘；
- 运行中的 `RunHandle`：控制通道、停止信号、串口租约。

## 系统启动项（不属于应用数据）

「开机自启动」开关（托盘菜单 / 文件菜单）由 `tauri-plugin-autostart` 写入操作系统启动项：Windows 为 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下的 `Remote Runner` 值（带 `--minimized` 参数，自启动时静默驻留托盘）。该注册表项不属于应用配置目录，删除配置目录不会清除它；需在应用内取消勾选或在 Windows 启动项管理中移除（设计见 `docs/00018_20260912_tray-autostart.md`）。

## 数据清理方式

当前没有应用内的数据清理入口。需要重置时：

- 删除配置目录（`%APPDATA%\com.devrunner.remote-runner`）即清除设备、历史与主机密钥信任；
- 清除 WebView 数据即重置布局、最近工作区与文件传输目录记忆；
- 远端工作区根目录（默认 `~/devrunner/workspaces/`）下的历次运行目录需手动清理（跨设备运行的本地暂存目录会自动清理）。
