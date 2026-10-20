# Remote Runner：跨设备脚本运行工作台

Remote Runner 是基于 Tauri 的桌面工具，用同一个工作台编辑工作区，并在 SSH、已登录 Linux Shell 的串口、Windows WSL 或本机 Shell 中运行 Python、Bash 和预置命令。React/TypeScript 负责交互，Rust/Tokio 负责校验、文件访问、环境准备和进程控制。

## 文档

- [00001 产品方案（HTML）](docs/00001-product.html)：需求、功能交互、使用流程与能力边界。
- [00002 技术方案（HTML）](docs/00002-architecture.html)：架构分层、模块职责、关键数据流与设计决策。
- [00000 完整索引](docs/00000-index.md)：六份 Markdown 详细设计、编号和维护约定。

HTML 主文档可直接在浏览器打开，支持目录跳转、窄屏和打印。也可启动 Vite 后访问 /docs/00001-product.html。

## 主要能力

- 本机及 SSH/WSL 设备工作区，目录管理、CodeMirror 多标签编辑、冲突检测与未保存保护。
- 工作区右键运行 Python/Bash 脚本、Python 模块或包，逐项参数及源端历史命令；全局预置命令单独维护。
- SSH/WSL 固定执行目录和增量同步，本机/同设备原地运行；实际执行位置、环境与同步结果可见。
- PTY/pipe、交互输入、单次 Ctrl+C、停止升级、超时、任务切换和独立终端。
- 设备默认 Python 或 uv 项目环境，支持准备、复用、重建与租约保护。
- 本机 ↔ SSH/WSL 二进制文件传输、队列、冲突策略、取消与失败重试。
- Windows USB 共享到 WSL2/远程 Linux，需 usbipd-win 和对应目标依赖。
- 工作区、标签、草稿与窗口恢复，以及中英文、主题、缩放、托盘、自启动、单实例和签名更新。

## 开始使用

1. 添加并测试 SSH、串口、WSL 或 Local 设备。
2. 打开本机或 SSH/WSL 设备工作区，在运行控制台选择目标、Python 环境和设置。
3. 右键脚本运行或带参数运行，在控制台查看结果并交互；自由 Shell 操作使用独立终端或预置命令。

串口需要事先登录 Linux Shell，仅上传有界 UTF-8 文本，不支持设备工作区或项目 Python。WSL 需要 Windows 与发行版内 Python 3.8+；项目环境不能替代该连接依赖。新工作区 .sh 入口需要实际 Bash。

原地运行的产物直接写入来源，远端副本产物不自动回传；跨设备到 Local 的暂存副本随运行结束清理。增量同步信任来源属性未变的成功清单，不是双向同步，也不保证发现目标单独修改。精确限额与恢复规则见 [工作区与增量同步](docs/00004-workspace-and-sync.md)。

## 本地开发与验证

需要 Node/npm、Rust/Cargo 及当前平台的 Tauri 开发依赖；Windows 还需 MSVC C++ 工具链和 WebView2。

~~~powershell
npm ci
npm run tauri dev
~~~

仓库根目录运行前端检查：

~~~powershell
npm test
npm run build
git diff --check
~~~

在 src-tauri 中运行：

~~~powershell
cargo fmt --all -- --check
cargo test --offline --all-targets
~~~

默认测试不依赖物理串口、USB 或用户 SSH 设备。WSL 为显式 opt-in；开发应用占用 exe 时可用独立 target 目录。环境要求、专项测试、浏览器样例、打包与签名发布流程统一见 [开发、验证与发布](docs/00008-development-and-release.md)。

## 详细设计

| 文档 | 内容 |
| --- | --- |
| [00003 运行与传输协议](docs/00003-execution-and-transports.md) | 请求、状态、控制、四通道约束 |
| [00004 工作区与增量同步](docs/00004-workspace-and-sync.md) | 安全文件服务、历史命令、来源与提交恢复 |
| [00005 Python 运行环境](docs/00005-python-runtime.md) | 项目契约、uv、缓存、重建与租约 |
| [00006 文件传输与 USB](docs/00006-transfer-and-usb.md) | 流式复制、提交、队列与 USB 管理 |
| [00007 客户端状态与恢复](docs/00007-state-and-recovery.md) | 前端、持久化、草稿及生命周期 |
| [00008 开发、验证与发布](docs/00008-development-and-release.md) | 开发、测试、打包、更新及说明模板 |
