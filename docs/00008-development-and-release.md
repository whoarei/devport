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

浏览器交互样例：`tests/run-console-browser.html` 与 `tests/editor-browser.html`，用模拟后端验证菜单、参数、编辑恢复和布局；不等于设备实测。主 HTML 文档可直接打开，或通过本地 Vite 访问 `/docs/00001-product.html` 和 `/docs/00002-architecture.html`。

## 4. 发布、版本与打包

正式流程见 [release skill](../.agents/skills/release/SKILL.md) 和 [Release workflow](../.github/workflows/release.yml)。稳定标签仅 `vX.Y.Z`；版本字段及 lockfile 用仓库脚本同步：

```powershell
node scripts/release.mjs sync vX.Y.Z
```

更新 `package.json`、`package-lock.json`、Tauri 配置、Cargo manifest 和 Cargo lock。实际发版时创建新的 `docs/releases/vX.Y.Z.md`，采用本文件第 6 节格式；无需恢复本次删除的旧发布说明。

版本与说明提交后，对确认的提交打标签并推送，GitHub Actions 精确 checkout 标签（包含 Git LFS 图标），构建 Windows x86_64 NSIS 与 portable exe，创建 draft Release，上传 updater 签名与 `latest.json` 并用 `scripts/release.mjs verify` 验证资产。workflow_dispatch 可重建已有稳定标签。构建通过不等于已公开；安装/升级验收后再公开草稿。

CI 需要 `TAURI_SIGNING_PRIVATE_KEY`，有口令时需要 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，缺私钥失败。私钥不得提交仓库。签名是 Tauri updater 的 minisign 校验，不等同于 Windows Authenticode。

本地验证打包：

```powershell
npm run tauri -- build --bundles nsis -- --locked
npm run tauri -- build --no-bundle -- --locked
```

本地普通配置不生成 updater 签名资产。默认主程序位于 `src-tauri/target/release/remote-runner.exe`，NSIS 在 `release/bundle/nsis`；指定 target 或输出目录后路径相应改变。CI portable 文件名为 `Remote.Runner_X.Y.Z_x64-portable.exe`。MSI 可单独选择，依赖当前平台打包工具，不是现有正式发布主通道。Linux/macOS 需各平台构建验证，不能把 Windows CI 视为全平台发布验收。

安装器默认在缺 WebView2 时联网安装；离线部署需预先准备运行时或调整安装模式并验证。直接分发 exe 也需要 WebView2。

## 5. 应用更新与安装验收

`update.rs` 从固定 GitHub `releases/latest/download/latest.json` 检查稳定版本，验证版本、平台和下载 URL；保持应用 identifier、公钥和安装身份稳定。Windows 已安装 release 可通过 Tauri updater 验证签名并安装；portable、debug、非支持平台或安装识别失败回退手动下载。

前端启动静默检查，有新版显示入口。安装与新运行/传输注册共享更新门闩，活跃任务、终端、传输和未处理编辑状态阻止安装；先刷新工作环境快照。下载进度后进入 verifying / installing。Windows 安装器接管应使旧程序退出，不能仅以 invoke 返回宣称成功。

公开前核对：NSIS、`.exe.sig`、portable、`latest.json` 一致；干净环境安装/启动、旧安装版升级、配置保留、重启/卸载、portable 手动回退及实际目标能力。说明未执行的硬件验证。旧版本回退不自动回滚数据 schema，应先备份，尤其注意新同步清单与旧版本兼容性。

## 6. 发布说明模板

实际发版时新建 `docs/releases/vX.Y.Z.md`：

```markdown
# Remote Runner vX.Y.Z

## 新功能

- 用户可观察到的新增行为；不把后端接口存在表述为完整 UI 功能。

## 修复

- 触发条件、原问题与现在的结果。

## 验证范围

- 本次执行的自动化、构建、目标系统及结果。
- 未执行的真实 SSH、物理串口、USB 或其他平台验证。

## 升级说明

- Windows 安装版可使用应用内更新。
- 便携版下载 Remote.Runner_X.Y.Z_x64-portable.exe。
- latest.json 与 .exe.sig 用于更新校验，不应单独运行。
- 本次配置/缓存兼容性变化及需要备份或手动处理的事项。
```

无需逐版本复制产品/技术全文。涉及需求、架构或限制变化时先更新对应设计；发布说明只表达本版本差异。
