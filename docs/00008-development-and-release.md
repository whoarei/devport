# 00008 开发、验证与发布

基线：2026-10-20 / 0.12.0。本文件记录现有仓库流程，不触发发版。架构入口见 [00002](00002-architecture.html)，文档维护见 [00000](00000-index.md)。

## 1. 开发环境

React/TypeScript 前端，Tauri 2 + Rust/Tokio 后端。需要 Node/npm、Rust/Cargo 与对应平台的 Tauri 桌面依赖；Windows 需要 MSVC C++ 工具链和 WebView2。锁文件固定依赖，CI 当前使用 Node 24。

仓库根目录：

```powershell
npm ci
npm run tauri dev
```

`npm run dev` 只启动 Vite，真实设备操作需要 Tauri；`npm run build` 只生成前端 `dist`。新增 Rust IPC 后需要重启开发程序，仅前端热更新不会载入它。

## 2. 基本交付检查

仓库根目录：

```powershell
npm test
npm run build
git diff --check
```

`src-tauri`：

```powershell
cargo fmt --all -- --check
cargo test --offline --all-targets
```

前端测试由 `scripts/test.mjs` 用 esbuild 打包、Node test runner 执行。Rust 测试涵盖验证、工作区、四通道生命周期、环境准备和本机 SSH/SFTP 集成；依赖已缓存才能离线执行。不要以旧文档固定测试数量作为完成标准，记录本次实际结果。

若正在运行的应用锁住默认 exe，使用独立输出目录，例如 `cargo test --offline --all-targets --target-dir target/docs-verification`；不为跑测试终止用户应用。需要构建后端时另执行 `cargo build --offline --bins`。只有文档/注释变化无需增加镜像测试，但要检查链接、锚点、HTML 渲染和残留引用。

## 3. 环境相关验证

WSL 为 opt-in，在 `src-tauri` 中设置实际发行版名：

```powershell
$env:REMOTE_RUNNER_TEST_WSL = 'Ubuntu-24.04'
cargo test --offline --lib wsl::tests -- --include-ignored
```

专项用例可按模块名筛选，如 `file_transfer::tests::wsl_binary_round_trip`、`workspace_sync::tests::wsl_workspace_sync_runs_repeatedly_in_place_and_cancels_a_queued_run`。全体 ignored 用例需明确了解其环境要求，顺序运行可避免并行启动 WSL 的资源竞争。

| 能力 | 默认自动化 | 仍需实际环境确认 |
| --- | --- | --- |
| Serial | Tokio duplex、本机 POSIX/Git Bash 包装命令 | UART/适配器、真实 Shell、bootloader、raw 模式时序 |
| SSH / SFTP | 本机 loopback 服务、断线和扩展能力模拟 | 外部设备、不同服务端、网络与权限 |
| Local | 检测到的真实本机 Shell，缺失自动跳过 | 不同 OS/ConPTY/CPython、用户 profile、桌面时序 |
| WSL | helper 模拟，显式启用后运行真实发行版 | 未安装发行版或其他发行版，不可宣称覆盖 |
| Python | FakeHost/fake uv、输入/缓存/重建/取消 | 公网下载、native wheel、aarch64/不同 libc |
| 文件传输 | 分块、冲突、残留、恢复、模拟 SFTP | 2 GiB 边界、不同文件系统和真实服务端 |
| USB | JSON、选择器、helper 和 USB/IP 协议模拟；可选只读探测 | 实际 UAC、开发 USB 转交、udev、跨机数据连接 |
| 工作环境 | 草稿/冲突/过期响应、模拟窗口/DPI | 原生多屏、托盘、自启动 |

普通测试不依赖物理串口、USB 或用户 SSH 凭据。`rr-cli` 是 SSH-only smoke 工具，只有存在授权可达目标时使用，不加入必须成功的普通硬件套件。

浏览器交互样例：`tests/run-console-browser.html`、`tests/editor-browser.html`、`tests/terminal-browser.html` 与 `tests/device-browser.html`，用模拟后端验证菜单、参数、编辑恢复、粘贴焦点、剪贴板延迟与会话替换、设备自动命名和布局；不等于设备实测。主 HTML 文档可直接打开，或通过本地 Vite 访问 `/docs/00001-product.html` 和 `/docs/00002-architecture.html`。

## 4. 发布、版本与打包

应用图标以根目录 `app-icon.png` 为唯一母版：深蓝圆角底、蓝色 R 和负形命令箭头。修改母版后运行 `npm run icons`，同时重建 `src-tauri/icons/` 中的 PNG、Windows ICO、macOS ICNS 及现有移动平台资源，避免打包图标与界面图标不一致。PNG 继续由 Git LFS 管理。`build.rs` 显式跟踪 `icons/`，保证增量构建也会更新 Windows 可执行文件内嵌的图标资源。

标题栏显示 18px，使用 18 / 36 / 54px PNG 适配 1× / 2× / 3× 屏幕；关于对话框显示 72px 图标，使用 256px PNG 保持高 DPI 清晰度。托盘通过 `tauri::include_image!` 编译嵌入 32px PNG，窗口与可执行文件使用 Tauri 配置中的图标。修改后需要重建并重启原生应用才能看到托盘与可执行文件图标；验收时分别检查浅色、深色背景和 16 / 18 / 24 / 32px 显示。

正式流程见 [release skill](../.agents/skills/release/SKILL.md) 和 [Release workflow](../.github/workflows/release.yml)。确认版本号前，先以当前分支上次稳定发布标签为基线核对提交及差异，在对话中展示新功能、修复、文档/维护调整、兼容性影响和建议版本，帮助用户判断。版本号尚未指定时再询问确认，已明确指定时沿用已有授权。稳定标签仅 `vX.Y.Z`；版本字段及 lockfile 用仓库脚本同步：

```powershell
node scripts/release.mjs sync vX.Y.Z
```

更新 `package.json`、`package-lock.json`、Tauri 配置、Cargo manifest 和 Cargo lock。实际发版时创建新的 `docs/releases/vX.Y.Z.md`，采用本文件第 6 节格式；无需恢复本次删除的旧发布说明。

版本与说明提交后，对确认的提交打标签并推送，GitHub Actions 精确 checkout 标签（包含 Git LFS 图标），构建 Windows x86_64 NSIS 与 portable exe，先创建 draft Release 并上传 updater 签名与 `latest.json`，再用 `scripts/release.mjs verify` 验证资产。全部通过后，工作流自动公开 Release 并设为 Latest，无需手动 Publish；上传或校验失败时不会执行公开步骤。workflow_dispatch 可重建已有稳定标签，校验通过后同样自动发布为 Latest。

CI 需要 `TAURI_SIGNING_PRIVATE_KEY`，有口令时需要 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，缺私钥失败。私钥不得提交仓库。签名是 Tauri updater 的 minisign 校验，不等同于 Windows Authenticode。

本地验证打包：

```powershell
npm run tauri -- build --bundles nsis -- --locked
npm run tauri -- build --no-bundle -- --locked
```

本地普通配置不生成 updater 签名资产。默认主程序位于 `src-tauri/target/release/devport.exe`，NSIS 在 `release/bundle/nsis`；指定 target 或输出目录后路径相应改变。CI portable 文件名为 `DevPort_X.Y.Z_x64-portable.exe`。MSI 可单独选择，依赖当前平台打包工具，不是现有正式发布主通道。Linux/macOS 需各平台构建验证，不能把 Windows CI 视为全平台发布验收。

安装器默认在缺 WebView2 时联网安装；离线部署需预先准备运行时或调整安装模式并验证。直接分发 exe 也需要 WebView2。

## 5. 应用更新与安装验收

### DevPort 改名兼容

GitHub 仓库原地重命名为 `whoarei/devport`，旧地址依赖 GitHub 重定向继续提供历史下载及更新。**不得重新创建 `whoarei/remote-runner` 仓库**，否则会覆盖重定向。旧发布标签、说明与产物保留原样。

从 1.0.0 开始，应用 identifier 为 `com.devport.app`，Rust crate 和程序为 `devport` / `devport.exe`，Windows 安装注册表与自启动名称为 DevPort，默认安装目录为 `%LOCALAPPDATA%/DevPort`。签名公钥保持不变。

首次启动在创建 WebView 和打开数据存储之前迁移旧 `com.devrunner.remote-runner` 数据：配置、设备、历史、运行日志、工作环境和未保存草稿复制到新目录；Windows WebView2 仅导入 Local Storage，浏览器缓存、Cookies 和机器绑定凭据不导入。复制在临时目录完成后提交；拒绝链接和 junction，旧 WebView 持有数据库锁时停止迁移并提示关闭旧版。已有 DevPort 目录始终优先，失败可重试，重复启动不会覆盖新数据。旧目录作为迁移前备份保留，新版正常运行不读取它，验证后可手动删除。

前端先导入旧 `remote-runner.*` 偏好为 `devport.*`，完成后才初始化语言、主题、布局及应用；已有新键优先。复制失败不标记完成，保留原值以供重试。新项目模板使用 `[tool.devport]`，读取时兼容 `[tool.remote-runner]`，两者存在时新表优先；不会重写用户项目。远端缓存、同步身份及协议中的历史内部名称继续保留，以保护已有资源所有权和缓存兼容性。

Windows 使用 Tauri 默认 NSIS 模板及 [迁移 hooks](../src-tauri/windows/README.md)。核对旧安装的路径、卸载命令和主程序记录后，使用旧卸载器的 `/S /UPDATE` 模式保留数据，安装新程序并迁移明确属于本应用的快捷方式与自启动；旧安装目录只做已知文件删除和空目录清理，不递归删除未知内容。自启动迁移保留 Windows StartupApproved 禁用状态。便携版首启也会导入配置及已识别的自启动项。

发布包含两套清单：`devport-latest.json` 使用新仓库地址供 1.0+ 客户端；`latest.json` 保留旧仓库前缀供 0.24.2 及更早客户端。CI 在草稿阶段生成、校验并回读两套清单，要求版本、签名及安装包完全一致，仅 URL 前缀不同。处理或上传失败不得公开；旧客户端仍可跳过中间版本直接升级。新版更新校验只接受 DevPort 仓库下载地址。

`update.rs` 从新清单检查稳定版本，验证版本、平台和下载 URL。Windows 已安装 release 可通过 Tauri updater 验证签名并安装；portable、debug、非支持平台或安装识别失败回退手动下载。修改 hooks 后执行 `./scripts/test-installer-migration.ps1`；该脚本使用唯一临时目录、独立注册表键和快捷方式，验证安装身份、二进制、自启动、快捷方式、重复安装及卸载，不操作真实安装。CI 在公开前同样执行该检查。自动化验证不等于对真实用户完整数据和各平台的升级实测。

前端启动静默检查，有新版显示入口。安装与新运行/终端/传输注册共享更新门闩，活跃任务、传输和未处理编辑状态阻止安装。有活动终端时，标题栏更新入口与关于对话框共用应用内确认框，跟随深浅主题，显示版本变化、活动终端数与命令中断提示；默认聚焦取消，Esc、关闭按钮与取消均保留终端。确认后刷新工作环境快照、关闭终端并等待清理完成，取消或关闭失败不安装；确认与清理期间禁止新建或重连终端。后端仍拒绝在存在未完成终端时安装，防止并发启动绕过清理。下载进度后进入 verifying / installing。Windows 安装器接管应使旧程序退出，不能仅以 invoke 返回宣称成功。

公开前核对：NSIS、`.exe.sig`、portable、`latest.json` 一致；干净环境安装/启动、旧安装版升级、配置保留、重启/卸载、portable 手动回退及实际目标能力。说明未执行的硬件验证。旧版本回退不自动回滚数据 schema，应先备份，尤其注意新同步清单与旧版本兼容性。

## 6. 发布说明模板

实际发版时新建 `docs/releases/vX.Y.Z.md`：

```markdown
# DevPort vX.Y.Z

## 新功能

- 用户可观察到的新增行为；不把后端接口存在表述为完整 UI 功能。

## 修复

- 触发条件、原问题与现在的结果。

## 验证范围

- 本次执行的自动化、构建、目标系统及结果。
- 未执行的真实 SSH、物理串口、USB 或其他平台验证。

## 升级说明

- Windows 安装版可使用应用内更新。
- 便携版下载 DevPort_X.Y.Z_x64-portable.exe。
- latest.json、devport-latest.json 与 .exe.sig 用于更新校验，不应单独运行。
- 本次配置/缓存兼容性变化及需要备份或手动处理的事项。
```

无需逐版本复制产品/技术全文。涉及需求、架构或限制变化时先更新对应设计；发布说明只表达本版本差异。
