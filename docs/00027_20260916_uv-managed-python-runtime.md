# 00027 uv-only Managed Python Runtime

日期：2026-09-16  
状态：已实现（2026-09-16，实施记录见 `00028_20260916_uv-runtime-implementation-progress.md`）

## 0. 实施状态与偏差

第 21 节的 8 个阶段已全部落地，验证基线：`cargo test --offline --all-targets` 142 通过 / 0 失败（10 ignored 为 WSL opt-in）、`npm test` 91 通过、`npm run build`、`cargo fmt --all -- --check`、`git diff --check` 全部通过。实现与本设计的偏差如下：

1. **Python build identity**：用 sha256(implementation|version|soabi|platform) 前 16 位摘要替代 python-build-standalone 官方 build id（uv 版本间接固定解释器清单，摘要足以作为 Environment ID 输入）。
2. **Runtime Catalog `size: 0`**：表示下载前不断言资产大小，一律以 sha256 为准。
3. **WSL 双 helper 会话**：prepare 使用独立的第二个 helper 会话（`WslHost::open`），未使用 `wsl::PrepareHook`（同步签名无法 await，且 build_script 在 init 时就需要 env python 路径）；PrepareHook 机制保留未用。
4. **网络模式**：`NetworkMode direct/mirror/offline` 的 Rust 边界与校验已实现，但运行入口目前固定 direct；mirror/offline 的 UI 接入留待后续。
5. **Windows 本机 Local**：不探测剩余空间（避免平台 API 依赖），空间检查跳过。
6. **LocalHost exec 测试**：依赖 `/bin/sh` 的用例拆分为 `#[cfg(unix)]`，与仓库"shell 缺失自动跳过"惯例一致。
7. **完成标准中未闭环项**：mirror/offline 的成功/失败测试、真实硬件/公网集成（SSH 真机、WSL opt-in、aarch64）仍为发布前验证项，默认自动化不依赖公网。

## 1. 目标与决策

Remote Runner 为 Python 项目提供完整的托管运行时：部署固定版本的 uv，由 uv 安装固定 patch 版本的 CPython，并依据 `uv.lock` 创建项目依赖环境。目标设备不需要预装 Python、pip、venv 或 uv。

本设计作出以下不可回退的产品决策：

1. Python 项目只支持 uv 项目模型，不支持 `requirements.txt`、Poetry、Pipenv 或手工 venv。
2. 只允许 uv-managed Python，禁止使用或回退到系统 Python。
3. `uv.lock` 是运行输入；Remote Runner 不在目标设备执行 `uv lock` 或更新依赖。
4. Runtime 与 Environment 分离：CPython 可被多个项目环境共享，项目环境按内容寻址。
5. uv 只负责 Runtime/Environment 准备；运行阶段直接启动环境中的 Python，不使用 `uv run`。
6. SSH、WSL、Local 首期完整支持；Serial Shell V1 明确不支持，等待可传输二进制的 Serial Agent。
7. 不满足平台、libc 或 Python bundle 支持矩阵时明确失败，不做隐式降级。

“一步到位”指最终语义一次确定、完成全部验收后统一开放，不代表用一个巨型提交完成。实现仍按第 17 节拆分。

## 2. 非目标

首版不包含：

- 自动迁移旧 `requirements.txt` 项目；
- 使用系统 Python、系统 pip 或 `python -m venv`；
- Conda、Poetry、Pipenv；
- PyPy、GraalPy、free-threaded/debug Python；
- 为任意远端架构交叉编译 sdist；
- 容器环境；
- Serial Shell V1 上的 Managed Runtime；
- 在稳定环境中 editable 安装根项目；
- 自动升级 uv、Python patch 或项目依赖。

## 3. 术语

### Managed Runtime

一次受 Remote Runner 管理的 uv + CPython 组合：

```text
uv version
target OS / arch / libc
exact CPython version
python-build-standalone build identity
```

### Project Environment

由 Managed Runtime 和 `uv.lock` 生成的项目依赖环境。底层仍是 Python virtual environment，但其创建、同步、路径和生命周期完全由 uv 与 Remote Runner 管理，用户不直接操作。

### DeviceRuntimeProfile

执行目标的运行时兼容性描述，包括 OS、架构、libc、内核、可写/可执行目录和空间信息。

## 4. 支持矩阵

| Transport | Managed Runtime | 说明 |
|---|---|---|
| SSH | 支持 | 上传 uv，目标端安装 Python 并同步依赖 |
| WSL | 支持 | 通过现有 WSL helper 使用结构化参数执行 |
| Local | 支持 | 在本机应用数据目录管理 Runtime/Environment |
| Serial Shell V1 | 不支持 | 当前仅支持有界 UTF-8 文本上传，无法部署二进制 Runtime |
| Serial Agent | 后续支持 | Agent 具备二进制上传、校验和进程控制后接入 |

选择不支持的目标启动 Python 项目时，在 Rust 边界返回 `managed_runtime_not_supported`，前端不显示 fallback 选项。

## 5. 项目契约

项目根目录必须包含：

```text
pyproject.toml
uv.lock
.python-version
```

`.python-version` 必须是完整、稳定的 CPython patch 版本：

```text
3.12.9
```

不接受 `3.12`、范围、多个版本、PyPy、debug 或 free-threaded variant。固定 patch 版本可以避免同一项目在不同时间自动选择不同解释器。

`pyproject.toml` 示例：

```toml
[project]
name = "audio-test"
requires-python = "==3.12.*"
dependencies = [
  "requests==2.32.5",
  "pyyaml==6.0.2",
]

[tool.remote-runner]
entry = "scripts/main.py"
mode = "script"              # script | module
python-path = ["src"]
dependency-groups = []
extras = []
```

校验规则：

- `.python-version` 必须满足 `project.requires-python`；
- `uv.lock` 必须存在且不超过配置上限；
- 使用 `uv sync --locked`，锁文件过期直接失败；
- `entry` 和 `python-path` 必须是工作区内不含 `.` / `..` 的相对路径；
- `mode = "module"` 时 entry 使用 Python module name 语法；
- `dependency-groups` 和 `extras` 只能引用项目中已声明的名称；空数组表示只安装 `[project].dependencies`；
- 首版拒绝 uv workspace member、editable dependency 和本地 path dependency；
- Git/URL dependency 可由 uv 处理，但必须已进入 `uv.lock`，认证信息不得写入项目文件；
- Remote Runner 不修改 `pyproject.toml`、`uv.lock` 或 `.python-version`。

根项目不安装到稳定环境中。同步使用 `--no-install-project`，运行时从上传后的 workspace 加载源码。`python-path` 由后端验证后加入 `PYTHONPATH`；默认工作目录为项目根目录。

## 6. 版本固定策略

Remote Runner 发布版本携带 Runtime Catalog，固定受支持的 uv 版本和平台资产：

```json
{
  "schema": 1,
  "uvVersion": "<pinned>",
  "assets": [
    {
      "platform": "linux-aarch64-gnu",
      "url": "https://...",
      "size": 0,
      "sha256": "..."
    }
  ]
}
```

uv 的可下载 Python 清单随 uv 版本冻结，因此 Environment ID 同时包含 uv 版本和最终 Python build identity。升级 uv 或 Python 是显式的 Runtime Catalog 变更，不在普通 Run 中自动发生。

官方行为参考：

- [uv Python versions](https://docs.astral.sh/uv/concepts/python-versions/)
- [uv platform support](https://docs.astral.sh/uv/reference/policies/platforms/)
- [uv settings: python-preference](https://docs.astral.sh/uv/reference/settings/)

## 7. 目标目录

SSH/WSL 默认使用用户可写路径，避免依赖 root：

```text
~/.remote-runner/runtime-v1/
├── tools/
│   └── uv/<uv-version>/<platform>/uv
├── python/                    # UV_PYTHON_INSTALL_DIR
├── envs/
│   └── <environment-id>/
├── cache/                     # UV_CACHE_DIR
├── locks/
├── manifests/
├── downloads/
└── quarantine/
```

Local 使用 Tauri 应用数据目录下的等价结构。Runtime 根目录必须为绝对路径，后端验证无 NUL、控制字符和 dot component；远端命令构造使用结构化参数或严格引用，不拼接未经验证的用户输入。

固定环境变量（Windows 路径使用对应的应用数据目录和路径格式）：

```text
UV_PYTHON_INSTALL_DIR=<runtime-root>/python
UV_PROJECT_ENVIRONMENT=<runtime-root>/envs/<environment-id>
UV_CACHE_DIR=<runtime-root>/cache
UV_NO_SYSTEM_CONFIG=1
```

不再注入 `UV_PYTHON_PREFERENCE`：uv 0.10+ 把它与显式 `--managed-python` 视为冲突来源（`cannot be used with --python-preference`），两者不能同时出现。managed-only 约束由 `--managed-python` 标志和 `UV_PYTHON_INSTALL_DIR` 共同表达。

依赖同步阶段再显式使用 `--managed-python --no-python-downloads`，保证 Python 已由 Runtime 安装阶段准备好，uv 不会寻找系统 Python 或临时下载另一个解释器。不得依赖目标机器的 PATH、active venv、用户级 uv 配置或系统级 uv 配置。

uv 建议缓存与环境位于同一文件系统，以获得链接复用能力：
[uv storage](https://docs.astral.sh/uv/reference/storage/)。

## 8. DeviceRuntimeProfile 与兼容性

后端在任何下载前探测：

```text
os
architecture
libc kind
libc version
kernel
home directory
runtime root writable
runtime root executable
free disk space
```

允许的平台必须由 Runtime Catalog 明确列出。不得仅根据 `uname -m` 猜测资产。

重要边界：uv 二进制能够运行不代表 Managed Python 或 native wheel 一定兼容。比如 uv 官方 Linux aarch64 GNU 构建有最低 glibc 要求；Python bundle、wheel、系统动态库仍可能有更严格要求。安装后必须执行实际 Python smoke test。

不支持时返回：

```text
unsupported_runtime_platform
unsupported_architecture
unsupported_libc
insufficient_runtime_space
runtime_root_not_executable
```

## 9. uv 部署与供应链

目标设备上禁止执行 `curl | sh`、PowerShell 网络安装脚本或系统包管理器安装 uv。

流程：

1. 桌面端按 Runtime Catalog 下载对应 uv 发布资产；
2. 校验下载 URL、长度和归档 SHA256；
3. 在桌面端安全解包，只接受 Catalog 指定的 uv 可执行文件，拒绝绝对路径、`..`、链接和额外文件；官方发布归档在同一目录随附 `uvx`（windows 资产另有 `uvw.exe`），这些伴生可执行文件被容忍但跳过，不参与部署也不写入目标设备；
4. 校验可执行文件长度和 SHA256，写入本地内容缓存；
5. 通过对应 transport 上传到目标临时文件；
6. 通过 transport 回读并计算 SHA256；不得假定目标已安装 `sha256sum`、Python、tar 或 unzip；
7. 设置仅当前用户可执行权限；
8. 在同一文件系统内原子发布到固定 uv 路径；
9. 执行 `uv --version` 并要求与 Catalog 完全一致。输出形如 `uv 0.12.13 (x86_64-unknown-linux-gnu)`：版本号必须逐项精确相等，版本号之后的括号目标三元组是正常输出，不算不匹配；多出的版本片段（dev 构建、第四段等）一律拒绝。

不允许 `uv self update`。Runtime Catalog、uv 许可证以及 Python/随附库许可证需要进入发布审查和第三方声明。

## 10. Managed Python 安装

Runtime 安装使用精确版本：

```text
uv python install 3.12.9
```

同时设置 `UV_PYTHON_INSTALL_DIR`，并要求 managed-only。安装完成后使用 uv 查询实际解释器路径，不依赖 PATH：

```text
uv python find 3.12.9 --managed-python
```

随后执行：

```text
<python> -VV
<python> -c "import json,platform,sys,sysconfig; ..."
```

记录解释器真实路径、实现、完整版本、platform、SOABI、libc 和 Python build identity。结果不符合请求即隔离并报错，绝不尝试系统 Python。

Environment 的解释器位置不得通过字符串拼接猜测。创建完成后由后端验证并记录实际路径：Windows 通常为 `<env>\\Scripts\\python.exe`，Unix 通常为 `<env>/bin/python`；任何平台都以探测和 smoke test 结果为准。

uv 默认数据目录和 `UV_PYTHON_INSTALL_DIR` 行为参考：
[uv Python CLI](https://docs.astral.sh/uv/reference/cli/)。

## 11. Environment ID 与 Manifest

Environment ID：

```text
SHA256(
  runtime-schema-version
  + uv-version
  + uv-platform
  + exact-python-version
  + resolved-python-build-id
  + device-os/arch/libc
  + uv.lock bytes
  + selected dependency groups
  + selected extras
  + normalized package source identity
)
```

项目源码不进入 Environment ID，因为根项目不安装到环境。修改脚本不会重建第三方依赖环境。

每个完成环境包含只读 manifest：

```json
{
  "schema": 1,
  "environmentId": "...",
  "uvVersion": "...",
  "pythonRequest": "3.12.9",
  "pythonExecutable": "...",
  "pythonVersion": "...",
  "pythonBuild": "...",
  "platform": "...",
  "libc": "...",
  "lockSha256": "...",
  "groups": ["default"],
  "extras": [],
  "createdAt": "...",
  "lastUsedAt": "..."
}
```

运行历史增加 `environment_id`、`uv_version`、`python_version` 和 `lock_sha256`，保证结果可追溯。

## 12. 环境创建、锁与恢复

虚拟环境可能在 console-script shebang 中保存绝对路径，因此不能在随机 staging 路径创建后整体 rename。采用“最终路径 + ready marker”事务：

1. 在 `locks/` 使用原子 `mkdir` 获取 Environment ID 锁；
2. 锁中写入 run ID、owner、开始时间和 heartbeat；
3. 检查已有 manifest、`.ready` 与 smoke test；
4. 无效环境移动到 `quarantine/` 或安全删除；
5. 设置 `UV_PROJECT_ENVIRONMENT` 为最终路径；
6. 执行：

   ```text
   uv sync
     --locked
     --no-install-project
     --no-default-groups
     --managed-python
     --no-python-downloads
     --no-progress
     [--group <name>]...
     [--extra <name>]...
   ```

   **约束**：`UV_PROJECT_ENVIRONMENT` 指向的目录在 `uv sync` 时必须为空或不存在——uv 0.10+ 把已含任何文件的目录当作“复用现有环境”，发现没有 Python 可执行文件就直接拒绝（`not a valid Python environment`）。因此不能在 sync 之前向该目录写 `.preparing` 标记或任何文件；环境目录由 uv 自己创建。
7. 用环境内 Python 执行 smoke test；
8. 原子写入 manifest，最后原子创建 `.ready`；
9. 释放锁。

其他 Run 等待同一锁并接收进度，不允许使用没有 `.ready` 的环境。锁使用 heartbeat 和有限过期策略；过期锁只有在确认 owner 不再活跃后才能接管。

Stop、timeout、进程异常或应用崩溃后，下一次准备会识别缺失 `.ready` 或无效 manifest，并执行恢复（隔离残留目录后重建）。不能把失败环境标记为缓存命中。

`uv sync --locked` 在锁文件与项目元数据不一致时失败，不应改写锁文件。uv 默认 exact sync 会移除未声明包，因此只能对 Remote Runner 专属 Environment 使用：
[uv locking and syncing](https://docs.astral.sh/uv/concepts/projects/sync/)。

`--no-default-groups` 用于屏蔽项目 `tool.uv.default-groups` 的隐式选择；Remote Runner 只按自身配置逐个传入 `--group` 和 `--extra`。这样 Environment ID 中的选择与实际安装集合一一对应。

## 13. 运行集成

准备完成后不使用 `uv run`。后端直接构造：

```text
cwd = uploaded workspace root
PYTHONPATH = validated python-path entries
argv = [<env-python>, "-u", <entry>, ...args]
```

module 模式：

```text
argv = [<env-python>, "-u", "-m", <module>, ...args]
```

完整顺序固定为：本地检查项目契约并计算 lock hash → 探测目标 profile → 部署/验证 uv → 安装/验证 Managed Python → 同步或确认 workspace → 在目标 workspace 中执行 locked environment sync → 直接启动 Environment Python。SSH 和 WSL 必须等 workspace 可见后才能运行 `uv sync`；Local 在原工作区中执行。

环境准备命令也必须接入现有 transport 的取消和进程组控制：

- SSH：独立 exec channel 和可终止进程组；
- WSL：现有 helper 控制协议；
- Local：portable-pty/pipe 会话层；
- Serial：启动前拒绝。

准备 uv/Python/依赖时产生的输出进入同一 Run 日志，但使用结构化 phase 区分，不伪装为用户脚本 stdout。

## 14. 状态与事件

保留现有顶层状态：

```text
preparing → syncing → starting → running → terminal state
```

给 `RunStatus` 增加可选 `phase`，避免为每个下载步骤扩张状态机：

```text
validating_project
probing_runtime
deploying_uv
installing_python
waiting_environment_lock
syncing_dependencies
verifying_environment
```

新增批量拉取事件：

```json
{
  "type": "runtime_progress",
  "run_id": "...",
  "phase": "installing_python",
  "message": "...",
  "downloaded_bytes": 0,
  "total_bytes": null
}
```

进度沿用现有有界 broadcast + `drain_run_events` 模型；落后时 `resync` 至少恢复 RunStatus 和 phase，字节级进度可以丢弃，不影响最终状态。

## 15. 网络、镜像与离线

支持三种显式模式：

### direct

目标设备直接访问 Python 下载源和 Python package index。

### mirror

管理员配置目标可访问的 Python runtime mirror 和 package index。Python mirror 通过 `UV_PYTHON_INSTALL_MIRROR` 指定；凭据来自系统凭据存储或运行时注入，不写入项目或历史。

### offline-wheelhouse

Remote Runner 上传 uv、Managed Python 安装资产和项目提供的目标平台 wheelhouse，然后使用 `--offline --no-index --find-links`。缺少 wheel、build backend 或 native build dependency 时明确失败。

Remote Runner 不承诺在 Windows x64 桌面为任意远端架构交叉构建 sdist。需要离线运行的项目必须准备目标平台 wheel；需要源码构建的项目必须在目标上具备完整编译工具和所有离线构建依赖。

uv 支持关闭网络以及替换 Python 下载镜像，镜像也可使用 `file://`：
[uv environment variables](https://docs.astral.sh/uv/reference/environment/)。

## 16. 缓存、清理与 UI

缓存层次：

- uv tool：按 uv version + platform；
- Python Runtime：按 uv version + Python build + platform；
- uv dependency cache：同一目标共享；
- Project Environment：按 Environment ID；
- workspace：仍按 run ID，与 Environment 分离。

每个活跃 Run 为 Runtime 和 Environment 创建 lease。GC 不得删除持锁、有 lease 或被活动进程使用的目录。

清理顺序：

1. 失败和未完成环境；
2. 过期 quarantine；
3. 无引用、最久未使用的 Environment；
4. uv dependency cache；
5. 无 Environment 引用的旧 Python Runtime；
6. 无引用旧 uv tool。

UI 增加：

- 项目 Python、uv、lock hash 和 Environment ID；
- 首次准备、缓存命中、当前 phase 和下载量；
- Managed-only 提示；
- 环境/Runtime 占用、最后使用时间；
- 重建环境、删除环境、清理缓存；
- Serial Shell V1 的不支持提示。

## 17. API 与 Rust 模型

建议核心模型：

```rust
struct ManagedPythonSpec {
    python_version: String,
    uv_version: String,
    lock_sha256: String,
    groups: Vec<String>,
    extras: Vec<String>,
}

struct DeviceRuntimeProfile {
    os: String,
    arch: String,
    libc: Option<String>,
    libc_version: Option<String>,
    runtime_root: String,
}

struct ManagedRuntime {
    id: String,
    uv_path: String,
    python_path: String,
    profile: DeviceRuntimeProfile,
}

struct ProjectEnvironment {
    id: String,
    path: String,
    python_path: String,
    manifest: EnvironmentManifest,
}
```

服务边界：

```text
ProjectInspector
RuntimeCatalog
RuntimeManager
EnvironmentManager
EnvironmentLock
EnvironmentGc
ManagedCommandSession
```

新增或扩展 invoke API：

```text
inspect_python_project
list_managed_runtimes
list_project_environments
rebuild_project_environment
delete_project_environment
clean_runtime_cache
```

正常运行仍通过 `run_script`，自动完成准备；前端不需要先显式调用 prepare API。

## 18. 错误模型

至少提供稳定错误代码：

```text
managed_runtime_not_supported
invalid_python_project
missing_uv_lock
stale_uv_lock
invalid_python_version
python_version_mismatch
unsupported_runtime_platform
unsupported_libc
insufficient_runtime_space
uv_asset_verification_failed
uv_version_mismatch
managed_python_install_failed
managed_python_verification_failed
environment_lock_timeout
environment_sync_failed
environment_verification_failed
offline_artifact_missing
runtime_cleanup_failed
```

错误信息不得包含 index 密码、token、私钥路径内容或完整带凭据 URL。日志和 UI 应同时展示 phase、可操作建议和底层退出码。

## 19. 安全要求

- 所有项目配置、路径和 Runtime Catalog 数据在 Rust 边界验证；
- uv/Python 资产必须经过 URL allowlist、长度和 SHA256 校验；
- 目标端再次校验上传资产；
- 不执行网络安装脚本，不调用系统包管理器；
- Runtime 根目录及文件权限限制为当前用户；
- 环境准备允许执行第三方 build backend，UI/文档必须说明其与运行项目代码具有相同信任级别；
- index 与 Git 凭据来自系统凭据存储，使用后不持久化到 history；
- 不读取目标机器全局 uv 配置，设置 `UV_NO_SYSTEM_CONFIG=1`；
- Runtime/Environment 删除必须验证绝对路径仍位于专用根目录，禁止跟随链接；
- 历史只保存非敏感 Runtime 身份。

## 20. 测试计划

### Rust 单元测试

- `pyproject.toml`、`.python-version`、`uv.lock` 校验；
- Python 版本与 `requires-python` 一致性；
- Environment ID 稳定性和输入变化；
- Runtime Catalog、URL、长度、SHA256 和平台选择；
- 所有路径包含、链接和删除边界；
- 锁竞争、heartbeat、过期恢复；
- `.preparing` / `.ready` / manifest 恢复矩阵；
- Stop、timeout 和失败清理；
- GC lease 与活动环境保护；
- 错误脱敏。

### Fake uv 集成测试

提供可编程 fake uv，覆盖：

- uv/Python 首次部署；
- 缓存命中；
- 分块输出与非 UTF-8 输出；
- lock 过期；
- 下载、sync、smoke test 失败；
- 并发 Run 只构建一次；
- 取消后无 `.ready`；
- 尝试返回系统 Python 时被拒绝。

### 真实集成测试

- Local：固定 uv/Python 测试资产，离线运行最小项目；
- WSL：保持 opt-in，验证首次安装、缓存、Stop 和清理；
- SSH：本地 SSH 测试服务覆盖协议，真实 Linux 设备作为发布前验证；
- aarch64 glibc/musl：发布前硬件或等价虚拟环境验证；
- Serial V1：验证在上传前返回明确不支持，不打开端口。

默认自动化不得依赖公网。需要下载的真实测试必须显式 opt-in。

## 21. 实施拆分

1. **项目模型**：ProjectInspector、配置/lock/version 校验、前端展示。
2. **Runtime 基础**：DeviceRuntimeProfile、Runtime Catalog、uv 下载校验与部署。
3. **Managed Python**：安装目录、managed-only 发现、smoke test 和 manifest。
4. **Environment**：Environment ID、最终路径事务、远端锁和 `uv sync --locked`。
5. **RunManager**：phase/progress、取消/超时、直接 Python argv、历史字段。
6. **缓存管理**：lease、列表、重建、删除、容量与 GC。
7. **网络模式**：direct、mirror、offline-wheelhouse 和凭据接入。
8. **验证与文档**：全量自动化、真实平台验收、00001/00002/README 同步。

代码可按以上顺序合并，但 UI 中的 Managed Runtime 开关保持隐藏，直到第 22 节全部满足。

## 22. 完成标准

- 干净的 SSH、WSL、Local 目标无需预装 Python 或 uv 即可运行；
- 运行中没有调用或发现系统 Python；
- 相同项目第二次运行缓存命中，不重新安装 Runtime/Environment；
- `uv.lock` 过期、Python 不匹配、ABI 不支持时明确失败；
- 两个并发 Run 只创建一次 Environment；
- 准备期间 Stop/timeout 能终止 uv/Python/sync 并留下可恢复状态；
- 应用或远端进程异常后能识别未完成环境和过期锁；
- history 可追溯 uv、Python、lock hash、Environment ID；
- direct、mirror、offline-wheelhouse 各有成功与失败测试；
- GC 不删除活动 Runtime/Environment；
- Serial Shell V1 在任何二进制部署前明确拒绝；
- 默认测试不依赖公网，硬件验证范围在发布说明中明确；
- `npm test`、`npm run build`、`cargo fmt --all -- --check`、`cargo test --offline --all-targets` 和 `git diff --check` 全部通过。

## 23. 主要风险

| 风险 | 处理 |
|---|---|
| 老旧 glibc/特殊架构不兼容 | 明确支持矩阵和 Runtime Catalog，拒绝 fallback |
| native wheel 或系统动态库缺失 | smoke test、明确错误；离线项目提供目标 wheelhouse |
| uv 升级改变 Python 清单或行为 | 固定 uv，升级视为 Runtime schema 变更 |
| venv 路径不可迁移 | 最终路径创建，以 `.ready` 原子发布，不整体 rename |
| 并发创建损坏环境 | 远端原子锁、heartbeat、manifest 和恢复流程 |
| 目标网络不可达 | mirror/offline-wheelhouse；不隐式切换模式 |
| 缓存无限增长 | lease-aware LRU/容量 GC |
| build backend 执行任意代码 | 明确信任边界，使用专用用户目录，不提升权限 |

## 24. 结论

Remote Runner 的 Python 支持将采用 uv-only Managed Runtime：固定 uv、固定 CPython patch、固定 `uv.lock`，以内容寻址 Environment 复用依赖，并直接用 Environment Python 启动脚本。该方案牺牲对旧项目、Serial Shell V1 和不受支持平台的兼容，换取单一、可追溯、无隐式降级的执行模型。
