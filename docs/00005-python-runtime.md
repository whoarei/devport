# 00005 Python 运行环境

基线：2026-10-20 / 0.12.0。产品选择见 [产品方案](00001-product.html#python)，运行提交及控制见 [00003](00003-execution-and-transports.md)。

## 1. 两种显式选择

| 选择 | 解释器来源 | 依赖管理 | 目标 |
| --- | --- | --- | --- |
| 设备默认 `device_default` | 当前目标环境解析到的 Python | 用户自行准备 | SSH / WSL / Local / Serial |
| 项目环境 `project` | 固定 uv 部署并解析的受管 CPython | 项目 `uv.lock` | SSH / WSL / Local |

两者都支持脚本及 `-m` 模块。项目模式失败不回退系统 Python；Serial 在任何运行时部署或端口操作前拒绝项目环境。WSL 即使使用项目环境，连接 helper 仍要求发行版预装 Python 3.8+。

本机默认 Python 先在所选 Shell/profile 内探测，取得实际解释器和完整环境，再直接启动。profile 新增/删除变量均生效，显式运行 env 最后覆盖。完整环境只用于后端启动，不回传探测 UI 或命令历史。Bash 及预置 Shell 命令不消费 Python 环境选择。

## 2. 项目契约和配置归属

项目模式必须有三份根文件：`pyproject.toml`、`uv.lock`、`.python-version`。新工作区运行入口由右键/历史命令指定，不要求专用 `entry` 或 `mode` 配置。

```toml
[project]
name = "example"
version = "0.1.0"
requires-python = ">=3.12.9,<3.13"
dependencies = []

[tool.remote-runner]
python-path = ["src"]
dependency-groups = []
extras = []
```

`.python-version` 可写 `3.12` 或 `3.12.9`，必须与 `requires-python` 兼容；不接受范围、多版本及其他 Python 变体。次版本请求在 3.12 系列中解析实际补丁，声明不改写；需要跨时间固定补丁则使用完整版本。

`python-path` 为经过验证的工作区内相对目录；groups/extras 必须已声明，默认不隐式安装项目 default groups。根项目不安装到依赖环境，源码从执行工作区加载。拒绝 uv workspace member、editable 和本地 path dependency；锁定的 Git/URL 依赖由 uv 处理。`uv.lock` 上限 8 MiB。

旧 `[tool.remote-runner].entry/mode` 只供兼容调用及可见导入候选，不能覆盖当前右键入口，未运行不能伪造历史。版本、依赖、groups/extras、源码搜索路径始终由项目文件读取，不迁入 `.runner/config.json` 或历史命令。

## 3. 运行时部署

发布内嵌 `runtime/uv-catalog.json`，当前固定 uv **0.12.13**。Catalog 包含 Linux x86_64/aarch64 GNU/musl、Windows x86_64/aarch64、macOS x86_64/aarch64 的 uv 资产及 SHA-256；资产存在不代表所有对应桌面、Python bundle、系统库及 wheel 组合已经实测兼容。

准备流水线：

1. 有界读取并校验源项目输入，冻结原始字节哈希。
2. 探测目标 OS、架构、libc、用户目录、可写/可执行根及可用空间；不能支持则明确失败。可报告空间时要求至少 2 GiB，Windows Local 当前跳过空间预检。
3. 桌面按 Catalog 下载 uv、校验归档 SHA-256、安全解包，只部署预期可执行文件；随档 uvx/uvw 可跳过。禁止网络安装脚本或 `uv self update`。
4. 上传临时 uv 并回读校验，原子发布到固定版本路径，再严格验证 `uv --version`。
5. 由 uv 安装并查询 managed CPython。次版本请求合并 `requires-python`；验证实际完整版本和 build，不使用系统 Python。
6. 确保源码已在实际执行目录可见，锁定环境配方，复用有效实例或在最终实例路径执行 locked sync。
7. 环境 Python smoke test → manifest → `.ready` → 原子发布配方绑定；交接租约后直接启动环境 Python。

执行过程中的具体源码同步与部署顺序由 runner 编排；核心不变量是 `uv sync` 使用实际执行目录，准备和发布前复查输入，不能对尚不可见或已变化的工作区创建“就绪”缓存。

固定目录：

```text
SSH / WSL: ~/.remote-runner/runtime-v1/
Local:     <app_config_dir>/runtime-v1/

tools/uv/<version>/<platform>/uv
python/                         # UV_PYTHON_INSTALL_DIR
envs/<instance-id>/              # 不搬移的实例最终路径
bindings/<recipe-id>.json        # 当前就绪实例指针
locks/  cache/  manifests/  downloads/  quarantine/
```

本机根的实际实现使用传入的应用配置目录。旧设计中的“应用数据目录”泛称不应被当作另一个实际路径。

同步使用 `uv sync --locked --no-install-project --no-default-groups --managed-python --no-python-downloads --no-progress --python <解析后的绝对解释器>`，按选择追加 group / extra。设置受控 `UV_PYTHON_INSTALL_DIR / UV_PROJECT_ENVIRONMENT / UV_CACHE_DIR / UV_NO_SYSTEM_CONFIG`，不与 `--managed-python` 同时设置会冲突的 `UV_PYTHON_PREFERENCE`。

锁过期直接失败，不在目标更新 `uv.lock`。uv 创建前环境目录必须为空或不存在，不预先写入 `.preparing`。运行阶段使用实际 Python `-u <绝对脚本> ...args` 或 `-u -m <模块> ...args`，不经 `activate` 或 `uv run`。

## 4. 配方、实例和租约

配方 ID 为规范化字符串输入 SHA-256 的前 32 个十六进制字符，包含 schema、uv 版本/平台、实际 Python 完整版本及 build、目标 OS/arch/libc、lock SHA-256、排序去重后的 groups/extras、包源身份。build 为 implementation/version/SOABI/platform 的摘要，不是官方发布 build 编号。源码内容不进入 ID，因此只改脚本可复用第三方依赖。

manifest 记录请求值、实际 Python、build、解释器路径、uv、平台、lock、选择及创建/使用时间。缓存提示只表示存在候选；启动前仍校验 manifest、ready、解释器和输入。

环境实例始终在最终路径创建，避免 venv shebang 中绝对路径因 rename 失效。配方锁串行准备，并维护远端 owner/心跳。重建创建新实例，在验证与绑定发布成功后切换指针，既有运行继续持有原实例。失败/取消清理本次未发布实例，即使已写 `.ready` 也不例外；已有绑定和实例保持可用。

`LeaseSet` 以引用计数跟踪活动实例，从准备/检查前获取，到运行终态释放。租约登记与清理/删除互斥，活动实例不得删除；多任务共享实例时不能第一次退出就将其标为空闲。环境锁的恢复规则与执行目录 lease 不同，不能通用地按“超时”接管所有锁。

## 5. 输入一致性、取消和界面

原始三文件哈希在源端、目标同步后、准备关键阶段及发布绑定前复查。SSH / WSL 上传这三份根文件保留原始字节；Serial 默认 Python 使用其 LF 文本规范。实际修改导致计划作废，不重新计算一次哈希掩盖冲突，也不静默启动旧环境。

准备/重建通过 `run_workspace(operation=prepare/rebuild)` 使用同一 RunManager 可取消生命周期。设置弹框显示冻结的工作区、目标、阶段、进度、最近日志和结果；关闭弹框任务继续，重开可查看；不改变主控制台当前任务或终端选择。

七个 phase：`validating_project`、`probing_runtime`、`deploying_uv`、`installing_python`、`waiting_environment_lock`、`syncing_dependencies`、`verifying_environment`。弹框只解码最近 64 KiB 诊断，跨块保留 UTF-8，显示时去 ANSI；完整原始输出仍遵循运行输出预算。

诊断记录路径、输入哈希、版本请求/解析、关键命令、缓存判断、退出码、耗时和失败清理。生成文字对 URL 凭据脱敏，不记录附加 env 值；不能保证用户脚本自身输出没有敏感数据。失败原因在终态前写入运行日志。

取消终止本次受控子进程并清理未发布代次，等待锁期间也可取消。WSL 文件会话维持心跳，长命令使用独立 helper；Local 探测有进程组/Job 守卫，SSH 使用可控 channel/进程组。

## 6. 当前限制与排障

UI 正常运行使用 direct 网络；Rust 存在 mirror/offline 配置与校验接口，不代表完整离线 wheelhouse 产品或镜像 UI 已交付。首次准备通常需要桌面下载 uv，且目标能获取 Python/锁定依赖。不支持 requirements/Poetry/Pipenv/Conda/任意已有 venv，不能以另一种依赖模型静默补救。

| 现象 | 核查 |
| --- | --- |
| 缺文件/版本不兼容 | 三文件、requires-python、groups/extras；修复源项目后重新检查 |
| 锁过期 | 在项目开发环境更新源锁文件，不让目标自动锁定 |
| `Project input changed` | 预期/实际哈希、源/目标字节数、校验端路径；不可绕过输入复查 |
| 平台/动态库不兼容 | profile、Catalog、CPython smoke test、native wheel 依赖 |
| 缓存命中却无法执行 | manifest、ready、解释器和当前项目输入；必要时显式重建 |
| 删除或清理被拒绝 | 仍被运行/准备租用，先等待相关任务结束 |

源码：[项目检查](../src-tauri/src/runtime/project.rs)、[准备流水线](../src-tauri/src/runtime/prepare.rs)、[配方 ID](../src-tauri/src/runtime/envid.rs)、[租约管理](../src-tauri/src/runtime/manager.rs)、[解释器探测](../src-tauri/src/workspace_probe.rs)、[设置与提交](../src/workspaceRunStore.ts)。自动化以 FakeHost 覆盖发布、取消与复用，不等同于联网下载或 aarch64 真机验证。
