# Remote Runner

在本机、SSH 设备、串口设备和 WSL 中运行脚本与命令的桌面工作台。

Remote Runner 将工作区编辑、Python 环境准备、脚本运行、交互终端和文件传输放在同一个界面中，适合远程开发、脚本调试和重复测试。运行目标可以是 Linux 服务器、开发板、虚拟机，也可以是本机 Shell 或 WSL 发行版。

[下载版本](https://github.com/whoarei/remote-runner/releases/latest) · [快速上手](#快速上手) · [开发入门](#开发入门) · [文档](#文档)

## 主要功能

- **跨设备运行**：支持 Python 脚本、Python 模块、Bash 脚本和自定义 Shell 命令，工作区来源与执行目标可分别选择。
- **工作区与编辑器**：打开本机或 SSH/WSL 设备目录，浏览文件树、新建、重命名和删除文件；提供多标签编辑、语法高亮、保存冲突检测及未保存保护。
- **Python 环境管理**：可使用设备默认 Python，也可按 uv 项目的版本与锁文件准备依赖环境，支持缓存复用、准备、重建和清理。
- **运行控制台**：实时查看输出、输入交互内容、发送中断、停止任务、设置超时，以及切换任务或重新运行。
- **常用操作复用**：工作区历史记忆入口与参数，全局预置命令保存常用 Shell 操作；SSH、串口、WSL 和本机支持独立的多标签终端。
- **工作区增量同步**：向 SSH/WSL 运行时复用固定执行目录，减少重复上传；本机和同设备工作区可原地运行。
- **双向文件传输**：在本机与 SSH/WSL 之间传输二进制文件、多选条目和目录，支持同名策略、进度、取消与失败重试。
- **Windows USB 共享**：将本机开发 USB 设备交给 WSL2 或远程 Linux，提供依赖检查、连接、断开与访问验证。
- **工作环境恢复**：恢复工作区、文件标签、编辑位置、未保存草稿和窗口状态；终端标签恢复后可手动重新连接。
- **桌面体验**：中文/英文、浅色/深色主题、界面缩放、可调整布局、托盘、自启动、单实例，以及安装版应用更新。

## 运行目标

| 连接方式 | 适用场景 | 准备条件 |
| --- | --- | --- |
| SSH | Linux 服务器、开发板、虚拟机等远程设备 | 可访问的 SSH 服务和有效凭据；工作区文件操作需要 SFTP |
| 串口 Shell | 通过 COM/tty 连接的 Linux 设备 | 运行和连接测试需已登录 Shell；可通过串口终端手动登录 |
| WSL | Windows 本机的 Linux 发行版 | 已安装的 WSL 发行版，内含 Python 3.8+ |
| 本机 Shell | 直接在当前计算机运行 | Windows 可使用 PowerShell、cmd、Git Bash、MSYS2；macOS/Linux 可使用 Bash、Zsh、sh |

运行 Python 时需要可用的解释器，或选择受支持的项目环境；运行工作区里的 `.sh` 脚本需要 Bash。串口仅支持文本工作区上传，不支持项目 Python 环境或通用文件传输。串口终端直接收发，关闭标签只断开连接并释放端口，设备上的程序可能继续运行；同一串口的终端、任务运行和连接测试互斥。

## 下载安装

从 [GitHub Releases](https://github.com/whoarei/remote-runner/releases/latest) 下载。当前发布流程提供 Windows x64 的两种分发形式：

| 版本 | 使用方式 |
| --- | --- |
| 安装包（NSIS） | 下载安装并启动，支持应用内签名更新 |
| 便携版（文件名以 `-portable.exe` 结尾） | 直接运行；更新时手动下载新版本 |

Windows 运行需要 WebView2。Linux/macOS 需自行准备环境、构建并验证，当前正式发布流程未提供对应安装包。

USB 共享为可选功能，Windows 需另行安装 usbipd-win 5.x；远程 Linux 还需 usbip、内核支持及相应操作权限，见 [文件传输与 USB](docs/00006-transfer-and-usb.md)。

## 快速上手

### 1. 添加运行目标

添加 SSH、串口、WSL 或本机 Shell 设备，填写对应配置并测试连接。第一次体验可以选择“本机 Shell”，使用当前机器上已有的 Python。

SSH 需要主机、端口、用户名和认证方式；WSL 选择发行版及可选用户；串口选择端口和波特率。

### 2. 打开工作区并编辑脚本

打开一个本机目录，或通过“打开设备工作区”选择 SSH/WSL 上的目录。在工作区中新建 `hello.py`，写入：

```python
import platform
import sys

print("Host:", platform.node())
print("Python:", sys.executable)
print("Arguments:", sys.argv[1:])
```

### 3. 选择环境并运行

在运行控制台选择目标设备，Python 环境选择“设备默认 Python”。在工作区右键 `hello.py` 并运行，控制台会显示执行机器、解释器和参数。

需要参数时，选择“带参数运行”，逐项添加参数；带空格的参数也作为单独一项输入。需要运行包或模块时，可使用工作区的 Python 模块运行入口。

运行前会保存工作区内的未保存文件，保存失败则不启动。运行设置可调整工作目录、附加环境变量、输出模式和超时。

### 4. 查看结果与重复执行

在控制台查看输出并输入交互内容。无选区时 Ctrl+C 发送一次中断；停止按钮执行终止流程。Windows 本机的 pipe 模式不支持单次中断，可使用 PTY 或停止按钮。

可以重新运行当前任务，也可以从工作区历史命令中复用入口和参数。历史命令使用当前选择的设备、环境和运行设置；常用的自由 Shell 操作可保存在预置命令面板中。

### 使用 uv 项目环境

需要按项目锁文件管理 Python 和依赖时，在工作区根目录准备：

```text
project/
├── hello.py
├── pyproject.toml
├── uv.lock
└── .python-version
```

选择“项目 Python 环境”，在运行设置中检查并准备环境，然后照常从工作区运行脚本或模块。首次准备会部署固定版本的 uv 与受管 Python，并按 `uv.lock` 安装依赖，通常需要网络；之后可复用就绪环境。支持 SSH、WSL 和本机目标。

版本与依赖由项目文件管理，应用不会自动更新锁文件。项目配置要求和排障方法见 [Python 运行环境](docs/00005-python-runtime.md)。

### 文件和运行产物

- 本机工作区在本机运行、设备工作区在同设备运行时，直接使用来源目录，产物也写在那里。
- 跨设备运行到 SSH/WSL 时，自动准备执行副本并显示实际目录；产物留在目标，可通过文件传输面板下载。
- 设备工作区跨到本机运行时使用临时副本，任务结束后清理该副本及其中的产物。

运行不会自动将远端修改或产物写回源工作区。增量同步也不等于双向同步，详细规则见 [工作区与增量同步](docs/00004-workspace-and-sync.md)。

关闭窗口后应用隐藏到托盘，任务继续；真正退出请使用退出菜单。重新启动可恢复编辑上下文和草稿，运行进程与控制台输出不在恢复范围内。

## 开发入门

前端使用 React、TypeScript 和 Vite，后端使用 Rust、Tokio 和 Tauri 2。

### 环境准备

- Git 与 Git LFS，仓库图标资源通过 LFS 管理。
- Node.js 和 npm；发布 CI 使用 Node.js 24。
- Rust 稳定工具链和 Cargo。
- 当前平台所需的 Tauri 开发依赖；Windows 需要 MSVC C++ 构建工具和 WebView2。

### 启动开发应用

```powershell
git clone https://github.com/whoarei/remote-runner.git
cd remote-runner
git lfs pull
npm ci
npm run tauri dev
```

`npm run tauri dev` 会启动前端和桌面后端。只预览前端可用 `npm run dev`，真实设备功能需要 Tauri 后端；修改 Rust 后需要重新启动开发应用。

### 测试与构建

在仓库根目录运行：

```powershell
npm test
npm run build
```

在 `src-tauri` 目录运行：

```powershell
cargo fmt --all -- --check
cargo test --offline --all-targets
```

默认测试不依赖用户的 SSH 设备、物理串口或 USB，WSL 集成测试按需显式启用。环境专项测试及验证边界见 [开发、验证与发布](docs/00008-development-and-release.md)。

Windows 本地构建安装包：

```powershell
npm run tauri -- build --bundles nsis -- --locked
```

默认输出在 `src-tauri/target/release/bundle/nsis/`。正式版本的签名、更新清单、产物校验和自动发布为 Latest 由 [Release 工作流](.github/workflows/release.yml) 完成。

### 代码目录

| 目录 | 内容 |
| --- | --- |
| src/ | React 界面、状态管理、编辑器、控制台和 IPC 调用 |
| src-tauri/src/ | 设备、运行调度、传输协议、工作区、Python 环境及桌面能力 |
| tests/ | 前端测试与浏览器交互样例 |
| scripts/ | 测试和发布工具 |
| docs/ | 产品方案、技术方案与详细设计 |

## 文档

- [产品方案](docs/00001-product.html)：完整功能、交互流程与能力边界。
- [技术方案](docs/00002-architecture.html)：架构、模块职责和关键设计。
- [开发、验证与发布](docs/00008-development-and-release.md)：开发环境、专项测试、打包和发布流程。
- [文档索引](docs/00000-index.md)：运行协议、工作区、Python、传输及状态恢复等详细设计。

两份 HTML 方案下载到本机后可用浏览器打开；Markdown 详细文档可直接在仓库中阅读。
