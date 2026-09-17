# 远端（设备）工作区

日期：2026-09-17

状态：已实现（后端 + 前端）。

## 1. 目标

工作区来源从「仅本机目录」扩展为「本机目录 **或** 某台设备上的目录」。打开设备上的目录后，可以就地浏览 / 编辑其中的文件，并选择任意设备运行其中的脚本：

- **运行目标 = 工作区所在设备**：原地运行（cd 到该目录直接执行，零拷贝，产物留在工作区，与 Local Shell 语义一致）；
- **运行目标 = 另一台设备**：两跳同步（先把源工作区下载到本机临时目录，再复用既有上传管线推到目标设备，串口文本限制、WSL 快照上限等策略自动生效）；
- **宿主设备范围**：SSH（标准 SFTP 子系统）与 WSL（扩展 `helper.py` 的控制协议，即 VS Code-WSL 的 agent 模型）。串口没有文件操作通道，不能作为宿主，但可以作为跨设备运行目标；
- **Managed Python**：仅「同设备原地运行」禁用（前端置灰 + 后端拒绝）。跨设备场景先落地本地临时目录，`runtime::project::inspect` 天然可用，保持支持。

## 2. WorkspaceRef：来源标识

```rust
#[serde(tag = "type", rename_all = "lowercase")]
pub enum WorkspaceRef {
    Local  { dir: String },
    Device { device_id: String, path: String },   // 设备上的绝对 posix 路径
}
```

- 自定义 `Deserialize` 兼容**裸字符串**：历史 `history.json` 与旧 localStorage 里的 `"D:\\foo"` 自动迁移为 `Local`；
- `RunRequest` 字段由 `workspace_dir: Option<String>` 改为 `workspace: Option<WorkspaceRef>`，并保留 `#[serde(alias = "workspace_dir")]` 以兼容旧请求体；
- `SaveRequest.dir` 改为 `SaveRequest.workspace`（`#[serde(alias = "dir")]`）；
- 设备路径校验 `validate_device_path`：绝对路径、无 `.` / `..` 组件、无 NUL/CR/LF —— 与 `DeviceProfile.workspace_root` 同规则。

前端 `src/api.ts` 镜像同名联合类型，并提供 `localWorkspace()` / `deviceWorkspace()` / `workspaceRefEquals()` / `isRemoteWorkspaceHost()`。

## 3. 后端结构

```text
src-tauri/src/workspace_ref.rs          来源类型、路径校验、宿主能力判断
src-tauri/src/remote_workspace/mod.rs   RemoteWorkspace（Ssh/Wsl 分派）+ SessionStore
src-tauri/src/remote_workspace/ssh.rs   SFTP 实现
src-tauri/src/remote_workspace/wsl.rs   helper fs_* 协议实现
src-tauri/src/remote_workspace/stage.rs 跨设备暂存下载
```

### 3.1 会话管理（SessionStore）

`AppState.workspace_sessions` 是**单槽**长连接（UI 同一时刻只有一个工作区）：

- `with(key, device, config_dir, op)`：会话键与请求不符则丢弃旧会话并重连，然后串行执行一个操作；
- 操作返回 `code == "io"`（连接类错误）时自动使会话失效，下次操作重连；
- `close()`：关闭工作区或切走时由前端 `close_workspace_session` 调用；
- **运行流程不复用该会话**：跨设备暂存另开连接，同设备原地运行使用 run 自己的连接，互不阻塞。

### 3.2 SSH（SFTP）

- 工作区根 `canonicalize` 一次（允许配置路径经过链接，操作落在真实目录上）；根以下**每一级组件**以 `symlink_metadata`(LSTAT) 拒绝符号链接，与本地 `resolve()` 语义对齐；
- 读取上限 1 MiB（编辑器）、暂存下载 64 MiB/文件；
- 写入 = 临时文件 `.rr-edit-<uuid>.tmp` → 复查原文件未变 → `rename` 替换。OpenSSH 的标准 `RENAME` 不覆盖已存在目标，此时退化为「先删后改名」（存在极短的缺文件窗口）；替换后复读并返回新 revision；
- revision = `sha256(内容 + 长度 + mtime)`，与本地同算法，任何写入都会改变它；
- 目录读取跳过隐藏项与符号链接；递归删除有条目预算（4096）。

### 3.3 WSL（helper 文件服务）

`helper.py` 新增 `fs_*` 消息族，与 SSH 侧能力一一对应：

| 消息 | 作用 |
| --- | --- |
| `fs_open` | 打开工作区根（要求已存在且为目录），建立 dirfd |
| `fs_list` | 列一层目录，逐条 `fs_entry` 流式返回 |
| `fs_read` | 读文件：`fs_file`（revision + size）→ `fs_chunk`* → `fs_done` |
| `fs_write` / `fs_wchunk` / `fs_wdone` | 临时文件 + 校验 revision + 原子替换 |
| `fs_create` | 新建文件 / 目录（可内联内容，上限 48 KiB） |
| `fs_rename` / `fs_delete` | 重命名 / 递归删除（有预算） |
| `fs_error` | 错误（`not_found` / `permission` / `exists` / `conflict` / `too_large` / `path` / `io`） |

- 所有文件操作在 helper 进程内用 **dirfd + `O_NOFOLLOW`** 完成，路径始终被约束在工作区根内（与既有上传防链接模式一致）；
- revision 由 helper 内部计算：`sha256(内容 + size + mtime_ns)`；
- 单控制帧上限 128 KiB，因此目录与文件内容都分块流式传输（`fs_chunk` 48 KiB）；
- `init` 消息新增 `cwd`（终端）与 `in_place`（原地运行：走 `walk()` 打开已存在目录而不是创建 run 目录）。

helper 的启动方式见 `docs/00007_20260912_wsl.md`：源码经 stdin 首行（base64）下发，命令行只保留极短的引导程序 —— 本次新增 `fs_*` 使 helper.py 从 18.6 KB 增长到 34.8 KB，超过 Windows 32767 字符的命令行上限，直接作为 `-c` 参数会让 `CreateProcess` 以 `os error 206` 失败（错误信息会被误读为「未安装发行版」）。

> 协议修正：`Message` 枚举原先依赖 `#[serde(rename_all = "lowercase")]` 生成 `exec_exit`，但该规则**不会插入下划线**（实际得到 `execexit`），helper 发出的 `{"type":"exec_exit"}` 一直无法反序列化到对应分支。现已为所有多词变体显式标注 `#[serde(rename = "...")]`。

### 3.4 跨设备暂存（stage.rs）

进入 `Syncing` 状态后，把源工作区递归下载到 `std::env::temp_dir()/remote-runner-stage-<run_id>`：

- 限额对齐 SSH 上传策略：单文件 64 MiB、总量 256 MiB、4096 条目、路径深度上限、跳过 `.git` / `.hg` / `.svn` 与符号链接；
- 下载完成后把请求改写为 `WorkspaceRef::Local { dir: 暂存目录 }`，**完全复用既有管线**（SSH SFTP 上传 / 串口文本 / WSL 快照 / 本地 cwd），Managed Runtime 的本地 `inspect` 也因此直接可用；
- 运行结束（无论成败）由 `Drop` guard 清理暂存目录。

## 4. 运行流程

`RunManager::start(request, device, config_dir, workspace_source)` 新增 `workspace_source`（设备工作区的宿主设备，由 `run_script` command 校验后传入）。

`validate_request`：

| 来源 | 校验 |
| --- | --- |
| `Local` | 现有 canonicalize + 入口文件存在性检查 |
| `Device` | `validate_device_path` + 设备存在 + transport ∈ {ssh, wsl}；入口存在性推迟到远程 stat |

`managed_python && 工作区就在目标设备上` → 明确报错「同设备原地运行暂不支持 Managed Python；请选择其他运行设备或关闭 Managed Python」。

`execute_inner` 分支：

- **同设备（SSH）**：跳过上传，用 run 自己的连接构造 `SshWorkspace::from_connection`，`check_script_entry` 校验入口（存在、普通文件、非链接），`remote_dir` 设为 canonical 工作区根；
- **同设备（WSL）**：`in_place = true`，helper 打开已存在目录并 cd，不创建 run 目录、不上传文件；
- **跨设备**：`Syncing` + 暂存下载 + 改写为 Local，随后走原逻辑；
- 最终把 `req.workspace` 写回 `Local { 运行实际使用的目录 }`，使历史记录与导出反映真实执行位置。

## 5. 终端联动

`open_workspace_terminal(device_id, workspace, subdir)`：

- 本机工作区 → 只能在本机（Local）设备打开，`cwd` 直接传给 spawn；
- 设备工作区 → 只能在托管它的那台设备上打开，`subdir` 经 `components()` 校验后拼成设备上的绝对路径；

SSH 终端在 shell 建立后注入 `cd <sh_quote(cwd)> || echo 'remote-runner: workspace directory not found'`；WSL 终端经 `init.cwd` 由 helper 在发行版内 chdir。串口终端不支持 cwd。

## 6. 前端

- `store.ts`：`workspaceDir: string | null` → `workspace: WorkspaceRef | null`，`setWorkspaceDir` → `setWorkspace`；目录树、标签页本就只用相对路径，无需改动；`startRun` 的相等性守卫改为 `workspaceRefEquals` 结构化比较；离开设备工作区时 `releaseRemoteSession` 尽力释放后端会话；
- `workspaceLabel()`：本机显示路径，远端显示 `设备名:/path`（标题栏、工作区面板标题、最近工作区菜单共用）；
- 新增 `RemoteWorkspaceDialog`：宿主设备下拉（仅 ssh / wsl）+ 路径输入 + 单层懒加载目录浏览（用 `list_workspace_dir` 列目录，成功即视为校验通过），路径校验与后端 `validate_device_path` 同规则；
- 入口：File 菜单「打开设备工作区…」、工作区面板空白区右键菜单同一项；
- 最近工作区升级为 v2（存 `WorkspaceRef` JSON）：读取时若 v2 键不存在则读 v1（裸字符串数组）迁移为 Local 条目、写回 v2 并删除 v1 键；非法条目丢弃、重复条目去重（保留首次出现顺序）；写入不可用时降级为仅本次会话可用；
- `RunToolbar`：payload 携带 `workspace`；当设备工作区与所选运行目标相同且入口为 `.py` 时置灰 Managed Python 并给出提示；
- `RuntimePanel`：项目环境重建需要本机可 `inspect` 的目录，仅本机工作区可用（设备工作区置灰）。

## 7. 限额与已知限制

| 项 | 值 / 说明 |
| --- | --- |
| 编辑器读写 | 1 MiB / 文件（远端与本地一致） |
| 暂存下载 | 64 MiB / 文件，256 MiB / 工作区，4096 条目，跳过 `.git` 等与符号链接 |
| WSL 单帧 | 128 KiB 控制帧；`fs_create` 内联内容 48 KiB，文件内容分块 48 KiB |
| SSH 写入替换 | 服务端不支持覆盖式 rename 时先删后改名，存在极短缺文件窗口 |
| 串口作为宿主 | 不支持（无文件操作通道） |
| 同设备原地 + Managed Python | 不支持（前端置灰 + 后端拒绝） |
| 设备工作区 + RuntimePanel 重建 | 不支持（需要本地目录） |
| 符号链接 | 工作区根以下一律拒绝（SSH 逐级 LSTAT / WSL `O_NOFOLLOW`） |

## 8. 验证

- Rust：`cargo test --offline --lib` 156 项通过（含 `workspace_ref` 兼容反序列化 / 路径校验 / 宿主能力、helper 协议编解码、runner 与 transport 分支）；`--test ssh_lifecycle` 5 项、`--test terminal_ssh` 3 项通过（均为本地仿真服务器，无硬件依赖）；
- 前端：`npm test` 102 项通过（新增 `tests/remoteWorkspace.test.ts` 覆盖 WorkspaceRef 比较 / 标签 / 置灰逻辑 / 设备路径助手 / 会话释放 / 对话框渲染；历史 v1→v2 迁移在 `tests/store.test.ts`）；`npm run build` 通过；
- **未覆盖**：开发环境没有可达的 SSH 设备与 WSL 发行版，SSH SFTP 与 WSL helper 的文件服务端到端行为无法实机验证；SSH/WSL 文件操作层由协议编解码单测与本地 POSIX 仿真覆盖，实机请按第 9 节清单人工确认。

## 9. 实机验证清单（待有设备时）

1. SSH 设备：打开 `/home/<user>/<项目>` 为工作区，确认目录树可展开、文件可读写、保存冲突提示正确（外部改动后保存应报 conflict）；
2. 同设备原地运行该目录下的 `.py` / `.sh`：确认不产生 `/tmp/devrunner/workspaces/*` 新目录，产物落在原目录；
3. 跨设备运行：以 SSH 设备目录为工作区、本机（Local）设备为目标，确认进入 `Syncing` 后有临时目录、运行结束后被清理；
4. 符号链接：在工作区内建链接指向外部文件，确认列表不显示、读写均被拒绝；
5. WSL 设备：同上 1–3（需发行版内 Python 3.8+）；
6. 终端：在设备工作区的子目录上「在终端中打开」，确认 cwd 正确；
7. Managed Python：设备工作区 + 同设备目标应置灰并给出提示；设备工作区 + 另一台设备目标应正常工作。
