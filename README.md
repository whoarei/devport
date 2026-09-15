# Remote Runner：远程脚本运行工具

Remote Runner 是基于 Tauri 的桌面工具，用于在远程设备上运行脚本和命令。只要目标设备支持 SSH、串口等通讯方式中的任意一种，即可使用本工具。它提供本地工作区界面、xterm 控制台、运行状态与历史记录，React 前端通过统一的运行接口调用 Rust 后端。

## 当前进度

| 功能 | 状态 |
|---|---|
| SSH 远程执行 | 已实现 |
| SSH 伪终端（PTY）与管道控制台 | 已实现 |
| SFTP 工作区上传 | 已实现 |
| 串口 Shell 第一版 | 已实现 |
| WSL 本机发行版直接执行（无需 SSH） | 已实现 |
| 本机 Shell 直接执行（pwsh / cmd / msys2 等） | 已实现 |
| 串口设备代理协议 | 待实现 |
| Node.js、Python 虚拟环境、托管运行时 | 待实现 |
| 运行产物下载、编辑器保存写回 | 待实现 |

## 功能特性

- 支持运行 Python 脚本、Shell 脚本及自定义命令。
- SSH 支持密钥、认证代理或密码认证，以及主机密钥校验、SFTP 上传、交互输入、终端尺寸调整、分级停止和历史记录持久化。
- 串口支持 Windows COM 和 Unix tty 端口，可配置波特率，使用 8N1、无流控设置；通过每次命令独有的随机标记判断执行完成，支持文本工作区上传、交互输入、Ctrl+C 停止和超时报告。
- 输出保留原始字节：Rust 后端将数据编码为 Base64 发送，前端解码后由 xterm.js 渲染。
- WSL 通过 `wsl.exe` 直接启动本机发行版内的进程，支持 PTY、pipe、工作区上传、交互输入、缩放、停止与超时，无需 SSH 服务或认证。
- 本机 Shell 直接在本机以指定 shell 运行（Windows：pwsh、powershell、cmd、msys2、Git Bash；macOS/Linux：bash、zsh、sh），工作区原地执行，支持 PTY、pipe、交互输入、缩放、停止与超时。
- 支持通过 `Ctrl/Cmd + +`、`Ctrl/Cmd + -` 缩放整个界面，`Ctrl/Cmd + 0` 恢复 100%；缩放比例会自动保存。

## 环境要求

- Node.js 和 npm。
- 包含 Cargo 的 Rust 工具链。
- 当前操作系统所需的 Tauri 桌面开发依赖；Windows 需要 WebView2 和 C++ 构建工具。
- 使用 SSH 时，需要可通过网络连接且开启 SSH 服务的目标设备（不限设备形态）及有效的认证信息。
- 使用串口时，需要串口适配器或设备，且远端控制台已登录 Shell。应用不自动执行串口登录或输入密码。
- 使用 WSL 时，桌面客户端需运行于 Windows，发行版内需有 Python 3.8+（`python3`）；Shell 脚本还需 `bash`。无需在发行版中安装常驻服务。

## 本地运行

安装前端依赖，启动 Tauri 开发应用：

```powershell
npm install
npm run tauri dev
```

`npm run dev` 可单独启动 Vite 前端开发服务器；调用设备功能需要同时运行 Tauri 后端。

## 使用设备

1. 在设备栏中添加 SSH、串口、WSL 或本机 Shell 设备。
2. 选择本地工作区，并选择 Python/Shell 入口脚本或切换到命令模式。
3. 点击运行按钮（界面中的 **Run**），在控制台查看输出并输入交互内容。

串口设备需要配置端口和波特率，固定使用 8 个数据位、无校验、1 个停止位、无流控。串口控制台合并显示输出，终端尺寸在命令启动时设置，不支持运行中调整。

串口工作区同步仅支持 UTF-8 文本文件，单文件最多 1 MiB，整个工作区最多 8 MiB。符号链接、特殊文件、重定向路径及含空字节（NUL）的文件会被拒绝，`.git`、`.hg`、`.svn` 目录会被跳过。

上传按最多 3 KiB 分块，每块确认成功后才继续；工作区最多包含 1024 个文件或目录。打开串口前会检查生成的 Shell 包装命令：每条命令最多 16 KiB，每个物理行最多 2048 字节，除换行外不能包含原始终端控制字符。复杂命令应写入脚本后上传执行。

停止操作会清空排队输入；只要已经发送过命令字节，就需要等待远端完成标记，否则报告远端状态未知。串口 Shell 与登录 Shell 共享输入通道，无法完全隔离进程退出瞬间的输入竞态，详见下方串口实现文档。

WSL 设备选择本机已安装的发行版，Linux 用户留空表示使用该发行版的默认用户。点击“测试连接”检查发行版与 Python 环境。每次运行将本地工作区复制到 WSL 工作区根目录下的独立运行目录；不选工作区的命令在 Linux 用户主目录执行。支持二进制文件，单文件最多 16 MiB、总计 64 MiB、最多 4096 个文件或目录；拒绝链接、重定向路径和特殊文件。生成的文件保留在 WSL 运行目录内，不自动下载或写回本地。详见 [WSL 直接连接](docs/00007_20260912_wsl.md)。

本机 Shell 设备选择自动探测到的 shell（可填自定义可执行路径覆盖）。工作区**原地运行**：不上传、不复制，运行产物直接写入工作区目录，因此运行期间请避免同时编辑工作区文件。Python/Shell 入口直接由解释器执行（不经 shell 拼接）；命令类型交给所选 shell 解释（pwsh/powershell 为 `-Command`，cmd 为 `/C`，posix shell 为 `-c`，msys2/Git Bash 附带 `-l` 获得完整 PATH）。cmd 命令内嵌双引号时行为可能不一致；cmd 设备运行 Shell 类型入口需为 `.bat`/`.cmd`，PowerShell 设备需为 `.ps1`。停止升级为 INT（Ctrl+C）→ TERM → KILL；Windows 上 pipe 模式无温和中断语义，停止直接终止进程树（`taskkill /T /F`）。详见 [本机 Shell 直连](docs/00023_20260913_local-shell.md)。

## 测试与验证

```powershell
npm test
npm run build

cd src-tauri
cargo fmt --all -- --check
cargo test --offline --all-targets
```

当前没有可用的串口硬件，串口测试使用模拟双向数据流和本机 Shell。SSH 集成测试使用本地模拟服务器，无需连接用户的 SSH 设备。本机 Shell 测试直接在本机可用 shell（至少 cmd / sh）上运行真实进程，shell 缺失时自动跳过。

普通 Windows 测试不依赖 WSL。已安装发行版时，可额外运行直接 WSL 集成测试（从 `src-tauri` 目录执行）：

```powershell
$env:REMOTE_RUNNER_TEST_WSL = 'Ubuntu-24.04' # 替换为实际发行版名
cargo test --offline --lib wsl::tests -- --include-ignored
```

## 发布流程

当前采用手工发布，仓库尚未提供自动构建与发布工作流。本节以 **Windows 桌面客户端** 为例；远端设备是 Linux，不代表需要将桌面安装包编译为 Linux 程序。以下 PowerShell 命令均从仓库根目录执行，任一步骤返回非零退出码都应先处理失败再继续。

### 1. 准备构建环境和发布配置

- 安装 Node.js/npm、Rust MSVC 工具链、Microsoft C++ Build Tools（选择“使用 C++ 的桌面开发”）及 WebView2；具体见 [Tauri 环境准备](https://v2.tauri.app/start/prerequisites/#windows)。
- 从准备发布的源码提交开始，确认 `git status --short` 没有意外改动，并记录 `node --version`、`npm --version`、`rustc --version` 及目标架构。
- 使用锁文件安装前端依赖：

```powershell
npm ci
```

首次发布时，准备方形 PNG/SVG 应用图标，例如将源图标保存为仓库根目录的 `app-icon.png`，然后生成平台图标：

```powershell
npm run tauri -- icon ./app-icon.png --output ./src-tauri/icons
```

当前 `src-tauri/tauri.conf.json` 的 `bundle.icon` 是空数组。生成后将该字段设置为以下路径，并将源图标、生成的桌面图标和配置一起纳入版本管理；图标路径相对于 `src-tauri`：

```json
["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"]
```

已有安装用户后，保持应用 `identifier`（当前为 `com.devrunner.remote-runner`）稳定。当前未配置代码签名和自动更新；分发的是手动下载安装包。若发布签名版本，在构建前配置签名证书及 Tauri 签名选项，证书私钥不要提交到仓库。

### 2. 更新版本号

下面以 `0.1.1` 为示例，实际发布时替换成目标版本：

```powershell
npm version 0.1.1 --no-git-tag-version
```

此命令更新 `package.json` 和 `package-lock.json`，不创建 Git 标签。再将 `src-tauri/tauri.conf.json` 的 `version`、`src-tauri/Cargo.toml` 的 `[package].version` 改成同一版本，并让 Cargo 更新锁文件中的本项目版本：

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
```

检查并保留 `src-tauri/Cargo.lock` 的相应变更。更新本次变更说明与已知限制，尤其要区分串口模拟测试结果与硬件实测结果。

### 3. 发布前验证

```powershell
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml --locked --all-targets
git diff --check
```

依赖已缓存时可以为 Cargo 测试添加 `--offline`。这些检查通过后，将本次版本、图标和文档变更提交，确认工作区干净；正式产物应从该提交构建。

### 4. 构建安装包

常用的 Windows NSIS 安装包：

```powershell
npm run tauri -- build --bundles nsis -- --locked
```

需要 MSI 时使用下面的命令：

```powershell
npm run tauri -- build --bundles msi -- --locked
```

不指定 `--bundles` 时，项目的 `bundle.targets = "all"` 会选择当前平台支持的全部安装包类型。Windows MSI 构建依赖 WiX/VBScript；具体要求见 [Tauri Windows 安装包说明](https://v2.tauri.app/distribute/windows-installer/)。首次打包可能需要联网下载打包工具。

`tauri build` 默认构建发布版本，并通过 `beforeBuildCommand` 自动运行 `npm run build`，将前端嵌入应用。单独的 `npm run build` 只生成网页资源，不生成桌面安装包。仅需构建可执行文件时可使用：

```powershell
npm run tauri -- build --no-bundle -- --locked
```

默认输出位置（未指定 `--target`，也未覆盖 Cargo 输出目录）：

| 产物 | 路径 |
|---|---|
| NSIS 安装程序 | `src-tauri/target/release/bundle/nsis/*-setup.exe` |
| MSI 安装程序 | `src-tauri/target/release/bundle/msi/*.msi` |
| 主程序 | `src-tauri/target/release/remote-runner.exe` |
| 前端资源 | `dist/`，不作为独立桌面安装包分发 |

默认按当前 Rust 工具链的宿主架构构建。显式指定例如 `--target x86_64-pc-windows-msvc` 时，应先安装对应的 Rust 编译目标，产物目录改为 `src-tauri/target/x86_64-pc-windows-msvc/release/` 下的对应位置。Linux/macOS 客户端需要在相应平台准备构建环境、打包并验证；本 Windows 流程不代表它们已经验证通过。

**离线安装：** 默认安装程序会在目标机器缺少 WebView2 时联网下载安装。若目标机器不能联网，应在步骤 1 将 `bundle.windows.webviewInstallMode` 设置为 `{"type":"offlineInstaller"}` 并纳入发布提交，把运行时安装程序包含在包内，包体积会增大；构建机器仍需准备相应依赖。详见 [WebView2 安装方式](https://v2.tauri.app/distribute/windows-installer/#webview2-installation-options)。直接分发主程序也需要目标机器已安装 WebView2。

### 5. 验证产物并分发

1. 从本次构建输出中选择当前版本和架构的安装包，避免混入旧版本文件。在测试 Windows 机器上验证安装、启动、设备配置保存/重载、旧版本升级及卸载。
2. 验证 SSH 和串口运行链路。有设备时检查脚本上传、交互、停止和超时；没有串口设备时，在发布说明中明确“串口仅完成模拟验证”，按实际验证范围发布测试版。
3. 对最终安装包计算 SHA256；如果进行了签名，应在签名完成后计算。以下示例列出 NSIS 安装包的哈希，选取本次版本的结果随包提供：

```powershell
Get-ChildItem ./src-tauri/target/release/bundle/nsis/*-setup.exe | Get-FileHash -Algorithm SHA256
```

4. 确认 `git status --short` 仍为空，给构建对应的提交创建标签，例如 `git tag -a v0.1.1 -m "Release v0.1.1"`。记录版本、标签、提交哈希、架构、验证范围和已知限制。
5. 将安装包、SHA256 和发布说明上传到约定的下载位置；若使用 GitHub/GitLab，先配置实际仓库远程地址，再推送发布提交及对应标签，并在仓库的版本发布页面创建发布记录、上传附件。仓库目前没有会随标签自动上传产物的工作流。

已有用户通过新安装包手动升级。回退时使用此前保留的安装包，并先备份应用配置；不要假定卸载或安装旧版本会自动回滚设备配置和历史数据。

## 相关文档

- [总体设计](docs/00001_20260908_embedded-linux-remote-script-runner-design.md)
- [实施进度](docs/00002_20260908_implementation-progress.md)
- [代码审查记录](docs/00003_20260908_code-review.md)
- [串口 Shell 第一版实现](docs/00004_20260908_serial-shell.md)
- [本机 Shell 直连设计](docs/00023_20260913_local-shell.md)
- [本机 Shell 直连实现细节](docs/00024_20260913_local-shell-implementation.md)
