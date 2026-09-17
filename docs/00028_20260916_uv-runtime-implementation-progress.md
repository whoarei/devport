# 00027 实施进度记录

> 本文档跟踪 `docs/00027_20260916_uv-managed-python-runtime.md`（uv-only Managed Python Runtime）的实施进度，随实施更新。最近一次更新：2026-09-17（实机暴露的四处 bug 修复：uv 归档伴生文件、`uv --version` 三元组输出、`UV_PYTHON_PREFERENCE` 与 `--managed-python` 冲突、`UV_PROJECT_ENVIRONMENT` 非空目录被 uv 拒绝，见文末）。

## 总览

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| ① | 项目模型 ProjectInspector | ✅ 完成 |
| ② | Runtime Catalog / Profile / Host 抽象 | ✅ 完成 |
| ③ | Managed Python 安装与验证（uv 部署 + python 安装） | ✅ 完成 |
| ④ | Environment ID / 远端锁 / uv sync 事务 | ✅ 完成 |
| ⑤ | RunManager 集成（phase / progress / argv） | ✅ 完成 |
| ⑥/⑦ | 管理命令 + lease/GC + 网络模式 API | ✅ 完成 |
| ⑧-前 | 前端展示与 i18n | ✅ 完成 |
| ⑧ | fake uv 集成测试（FakeHost） | ✅ 完成 |
| — | 全量验证（npm test/build、cargo fmt/test、git diff --check） | ✅ 完成 |
| — | 文档同步（00027 状态标注 + 00001/00002/README 补充） | ⬜ 未开始 |

**验证基线（2026-09-16，⑧ 后）**：`cargo check --offline --all-targets` 0 error 0 warning；`cargo fmt --all -- --check` 通过；`cargo test --offline --all-targets` 142 通过 / 0 失败（10 ignored 为既有 WSL opt-in 测试）；`npm test` 91 通过；`npm run build`（含 tsc）通过；`git diff --check` 通过。

> **⑤ 状态更正（⑥/⑦ 实施时核实，已在 ⑤ 收尾中解决）**：00028 此前记录 ⑤ 已完成，但核实发现运行主流程未接入（build_script 无 managed 分支、managed_* 字段无消费方、prepare 仅被 rebuild 调用）。本次已补齐，见下方"⑤ 收尾已完成"。

## 已落地的关键决策

- **新增依赖**（`src-tauri/Cargo.toml`，已验证离线可编译）：`toml 0.8`、`tar 0.4`、`flate2 1`、`reqwest 0.13`（`blocking` + `rustls`，0.13 特性名是 `rustls` 不是 `rustls-tls`）、`zip 4`（`default-features = false, features = ["deflate"]`）。
- **uv 固定 0.12.13**，8 平台资产 sha256 从 GitHub 真实拉取，写入 `src-tauri/src/runtime/uv-catalog.json`；`size: 0` 表示跳过大小断言、以 sha256 为准。
- **`RuntimeHost` trait**（`runtime/host.rs`）统一抽象，方法签名统一生命周期 `fn xxx<'a>(&'a self, path: &'a str, ...) -> BoxFuture<'a, ...>`。实现：Local（`hosts/local.rs`）、SSH（`hosts/ssh.rs`，持 `Arc<Handle>`；`SshConnection.handle` 已改为 `Arc<Handle>` 共享）、WSL（`hosts/wsl.rs`，持 `Arc<tokio::sync::Mutex<Bridge>>`，parking_lot guard 不能跨 await）。
- **SSH exec**：`printf marker; exec env ...` 包装捕获远程 PID；cancel 时 `pkill -KILL -P pid; kill -KILL pid; kill -KILL -- -pid`。
- **WSL helper.py** 扩展 exec 协议：`exec_begin`（argv/env/cwd 逐 ack）→ `exec_input`（48KB b64 分块 ack）→ `exec_run` → Output 流 → `exec_exit`；`wsl/mod.rs` 提供 `pub(crate) async fn exec_managed(...)`。
- **WSL managed 流程**：hook 内用独立 `WslHost::open`（第二个 helper 会话 B）跑 prepare_environment，uv sync 读磁盘文件，无需共享 run 的 bridge A。
- **Python build identity** = sha256(implementation|version|soabi|platform) hex 前 16 位（替代 Astral 官方 build id，属于对 00027 的偏差，需在 00027 标注）。
- **RunRequest 新增**（serde default）：`managed_python`、`managed_env_python`、`managed_pythonpath`、`managed_module`（后三个 skip 序列化，准备阶段回填）。
- **RunStatus 新增**：`phase` / `environment_id` / `uv_version` / `python_version` / `lock_sha256`（全 Option + skip_serializing_if none，兼容旧 history.json）。
- **取消机制**：RunHandle 加 `runtime_cancel: Arc<AtomicBool>`，stop() 置位，prepare exec 循环周期检查；错误码 `managed_runtime_canceled` 在 `execute()` 映射为 Canceled 终态。
- **prepare 分两段**：`prepare_runtime`（probe + uv 部署 + python 安装）→ `prepare_environment`（锁 + sync + manifest）。SSH/WSL 先上传 workspace 再 prepare_environment（远端路径）；Local 用本地项目路径。
- **运行阶段不用 `uv run`**：SSH/WSL 走 `build_script` managed 分支（`exec <env-python> -u ./entry` 或 `-m module` + `export PYTHONPATH`）；Local 走 `local::invocation` managed 分支直接 spawn env python。
- **Serial V1** 在任何端口操作前返回 `managed_runtime_not_supported`。
- **网络模式**：`NetworkMode Direct/Mirror/Offline`（`runtime/prepare.rs`）。

## 新增文件

`src-tauri/src/runtime/` 全部新增：

- `mod.rs` — 类型 + 错误码常量 `code::*` + `scrub_credentials` + `validate_runtime_root`，已注册 `pub mod runtime;` 到 lib.rs
- `uv-catalog.json` — 固定 uv 0.12.13 的 8 平台资产目录
- `catalog.rs` — Catalog 解析/校验/平台选择（含单测）
- `project.rs` — ProjectInspector（含单测）
- `download.rs` — uv 资产下载/校验/解包（tar.gz/zip）
- `profile.rs` — 设备 runtime profile 探测与支持矩阵检查
- `envid.rs` — Environment ID 计算
- `manifest.rs` — 环境 manifest（ready marker）
- `lock.rs` — 远端环境锁（heartbeat 15s，过期 90s，超时 600s；acquire 收 `Arc<dyn RuntimeHost+Send+Sync>`）
- `manager.rs` — LeaseSet / delete / clean / rebuild / list（含单测）
- `manage.rs` — 管理命令支撑：open_host / rebuild_on_device / 工作区临时上传（含单测）
- `prepare.rs` — prepare_runtime / prepare_environment + NetworkMode + PrepareEvents
- `host.rs` + `hosts/{mod,local,ssh,wsl}.rs` — RuntimeHost 抽象与三端实现
- `fake.rs`（`#[cfg(test)]`）— FakeHost + 可编程 fake uv 与 9 个 prepare 流水线集成测试

修改的文件：`src-tauri/src/error.rs`（`ManagedRuntime` 变体 + `RunnerError::managed()`）、`runner.rs`、`ssh/client.rs`、`wsl/mod.rs`、`wsl/helper.py`、`bin/rr_cli.rs`、`wsl/tests.rs`、`commands.rs`（⑥/⑦ 管理命令 + AppState.leases）、`lib.rs`（invoke_handler 注册）。

## ⑤ 收尾时修复的 bug（实施中暴露）

1. **catalog**：`RuntimeCatalog` serde 字段名不匹配 JSON 的 `uvVersion`（加 `rename_all = "camelCase"`）；URL 版本 tag 取下标错误（`nth(3)` → `nth(4)`）。
2. **project**：`satisfies_requires_python` 只认空格分隔的操作符，`==3.12.*` 误判不满足；改为前缀匹配操作符集合 `["~=", "===", "==", "!=", "<=", ">=", "<", ">"]`。
3. **lock**：首次 acquire 时 `locks/` 父目录不存在直接 NotFound；acquire 内先 `mkdir_all(locks_root)`（幂等，锁获取仍靠 mkdir 原子性）。
4. **profile**：`check_support` 第一处 match 把 Windows 误拒（前置只放行 linux/macos），补 `windows`。
5. **download**：tar 0.4 的 `set_path` 拒绝 `..`/绝对路径，无法构造路径逃逸测试条目；改为手写 ustar 头（`raw_header`）。
6. **runner.rs / rr_cli.rs / wsl/tests.rs**：适配新函数签名（`execute_with_command` 第 7 参 `prepare_hook`、RunRequest 新字段）。
7. **hosts/local.rs 测试**：exec 相关测试依赖 `/bin/sh`，Windows 本机不存在，拆分为 `#[cfg(unix)]`（与仓库"shell 缺失自动跳过"惯例一致）。

## ⑤ 已验证 / 未验证

- ✅ 编译零错误零警告（lib + all targets）
- ✅ `cargo test --offline --lib` 124 通过
- ⚠️ SSH exec 的 PID marker 解析逻辑**无真机验证**（仅编译 + 单测）
- ⚠️ SSH/WSL/真 uv 的真实集成为 opt-in，**尚未跑过**
- ⚠️ Windows 本机 Local managed 流程未实测（理论可行：LocalHost 直接 spawn uv.exe）

## 剩余工作明细

### ⑤ 收尾已完成（2026-09-16）

- **SSH**（`execute_inner`）：连接后 inspect 项目 → SshHost `prepare_runtime` → 上传 workspace → `prepare_environment(remote_dir)` → 回填 `managed_env_python / managed_pythonpath / managed_module / entry` → `EnvLeaseGuard` 持 lease 至 run 结束（含失败/取消路径，RAII drop 释放）。
- **WSL**（`execute_wsl`）：独立 `WslHost::open` 会话先经 `manage::upload_wsl_workspace`（collect + write_file）上传 workspace，再 prepare_runtime/environment；运行会话（bridge A）零文件上传直接 cd 到已就绪目录。**偏差**：未使用 `wsl::PrepareHook`（同步签名无法 await，且 build_script 在 init 时就需要 env python 路径），PrepareHook 机制保留未用。
- **Local**（`execute_local` + `local::invocation`/`spec_for`）：LocalHost（`config_dir/runtime-v1`）原地 prepare；invocation managed 分支直接 spawn env python（`-u` / `-u -m`），PYTHONPATH 经 `std::env::join_paths` 注入 SessionSpec env。
- **build_script managed 分支**：`exec <env-python> -u ./entry`（或 `-m module`）+ `export PYTHONPATH=<remote>/<entry>...`；非 managed 路径不变。
- **取消**：RunHandle 新增 `runtime_cancel: Arc<AtomicBool>`，stop() 置位；prepare exec 周期检查返回 `managed_runtime_canceled`，`execute()` 映射为 Canceled 终态。
- **事件**：`RunEvent::RuntimeProgress { run_id, phase, message, downloaded_bytes, total_bytes }`；phase 写 RunStatus.phase 并发 Status 事件；prepare 过程输出经 `emit_output` 进同一 Run 日志；rr_cli 两个 match 补新变体。
- **lease 共享**：`RunManager.leases: Arc<LeaseSet>` + `attach_leases()`，lib.rs 与 AppState 共享同一实例。
- **校验**：start() 在端口操作前拒绝 Serial + managed（`managed_runtime_not_supported`）；validate_request 要求 managed 必须是 python 类型，entry 文件级校验移交 ProjectInspector（module 模式 entry 是模块名）。
- **PrepareEvents 重构**：借用闭包 `&'a mut dyn FnMut` 改为 owned `Box<dyn FnMut + Send>`（prepare/manager/manage/runner 四处签名同步），运行流程可自由持有事件回调跨 await。
- 新增单测 6 个：build_script script/module 分支、managed 非 python 拒绝、Serial 前置拒绝、stop 置位 runtime_cancel、EnvLeaseGuard drop 释放。
- **运行期限制**：run_script 目前固定 `NetworkConfig::default()`（direct）；mirror/offline 接入 RunRequest 留待前端阶段。

### ⑥/⑦ 已完成（2026-09-16）

- `runtime/manage.rs`（新增）：`open_host`（按 transport 构造 host，Serial 返回 `managed_runtime_not_supported`）、`rebuild_on_device`（Local 原地；SSH 经 SFTP、WSL 经 collect+write_file 上传工作区到 `<workspace_root>/env-rebuild-<uuid>` 临时目录，结束后尽力清理）。
- `commands.rs` 新增 6 个 invoke API 并在 `lib.rs` 注册：`inspect_python_project` / `list_managed_runtimes` / `list_project_environments`（列表类连接失败 best-effort 降级为 present=false / 空列表，Serial 明确报错）/ `rebuild_project_environment(device_id, workspace_dir, network?)` / `delete_project_environment` / `clean_runtime_cache`。
- `AppState.leases: Arc<LeaseSet>`；`NetworkMode/NetworkConfig` 增加 serde + `validate()`（mirror 必须给出镜像地址，scheme 白名单 https/http/file）；`PreparedEnvironment` 增加 serde。
- 新增单测 3 个（network 校验、root 形态、Serial 前置拒绝）；顺手修复 `hosts/local.rs` 测试在 Windows 下的 unused import 警告，并对既有文件执行了 `cargo fmt --all`（catalog/profile 等文件存在基线格式漂移）。

### 前端展示与 i18n（已完成，2026-09-16）

- `src/api.ts`：RunStatus 增加 `phase / environment_id / uv_version / python_version / lock_sha256` 可选字段；RunEvent 增加 `runtime_progress` 变体；RunRequest 增加 `managed_python`；新增 `PythonProject / ManagedRuntimeInfo / EnvironmentManifest / ProjectEnvironmentInfo / NetworkConfig / PreparedEnvironment` 类型与 6 个管理 API 绑定。
- `src/store.ts`：新增 `runProgress`（每个 run 的最新准备进度消息；终态清除、resync 重置），`handleRunEvents` 处理 `runtime_progress`。
- `RunToolbar`：python 入口时显示「uv 托管」开关（串口设备禁用并提示）；状态区显示 phase 标签与最新进度消息；`RunDraft.managed` 持久化在草稿中。
- `HistoryPanel`：有 `environment_id` 的条目显示 `uv · Python · 环境前 8 位` 追溯行。
- **Runtime 管理面板**（新 sidebar 面板 `runtime`，默认隐藏，视图菜单可开）：Managed Runtime 摘要（uv 版本/平台/部署状态）+ 项目环境列表（ready/leased 徽章、manifest 摘要、最后使用时间）+ 刷新 / 重建环境（需已打开工作区）/ 删除环境（leased 禁用）/ 清理缓存（二次确认）；串口设备显示不支持提示。注册：`panels/registry.tsx` + `panels/components.ts` + `layoutState.ts` 迁移键。
- i18n：`menu.runtimePanel`、`phase.*`（7 个阶段）、`run.managed*`、`history.managed`、`runtime.*`（面板全部字符串），zh 为准、en 类型约束同步。
- 前端 rebuild 固定不传 network（后端默认 direct）；mirror/offline 的 UI 留待网络模式阶段。

### ⑧ fake uv 集成测试（已完成，2026-09-16）

`runtime/fake.rs`（`#[cfg(test)]`，约 700 行）实现 `FakeHost` + 可编程 fake uv，9 个集成测试全部通过：

- **FakeHost**：内存文件系统（文件/目录/`rename` 支持目录子树、`mkdir` 父目录必须存在以保锁原子性、`remove` 幂等）+ 可编程 exec（posix 探测脚本、`.probe-*` 可执行性探针、`uv --version` / `python install` / `python find` / `sync` / `cache`、环境内 Python 信息探针与 smoke test）。`Behavior` 可中途改：`uv_version` / `python_version` / `find_returns_system` / `sync_fails` / `sync_stderr`；计数器 `deploys`（uv 上传次数）/ `install_count` / `sync_count` 与 `exec_log` 供断言。
- **离线资产**：不用内嵌 Catalog（其 sha256 对应真实资产），测试用 `RuntimeCatalog::parse` 注入单平台 Catalog（`size: 0`），tar.gz 由 `tar::Builder` + `flate2` 自制（复刻真实归档布局：目录条目 + `uvx` 在前、`uv` 在后，见下节 bug 修复），sha256 写入 Catalog 并经 `download::store_cache` 预置桌面端内容缓存——`cached_asset` 命中，全程无网络。
- **覆盖矩阵**（9 个测试）：首次部署全流程（uv 发布、install/sync 各 1 次、manifest + `.ready`、phase 序列）；二次运行缓存命中（`deploys` 仍 1、`sync_count` 仍 1、`cache_hit=true`）；sync 失败（`environment_sync_failed`、`.preparing` 残留无 `.ready`，修复后重跑隔离残留到 quarantine 并成功）；取消（预置 cancel → `managed_runtime_canceled`，零部署零 sync）；`python find` 指回系统路径与 Python 版本报告不符均拒绝（`managed_python_verification_failed`）；并发两 prepare 同环境只 sync 一次（共享 FakeHost + 远端锁，恰好一个 cache_hit）；非 UTF-8 stderr 原样透传到输出事件；cancel 置位后任何 exec 立即拒绝。

### 全量验证

`npm test`、`npm run build`、`cargo fmt --all -- --check`、`cargo test --offline --all-targets`、`git diff --check`。

### 文档同步

- `docs/00027` 状态改为已实现 + 标注偏差（build identity 用摘要替代官方 build id、catalog `size=0` 语义、WSL 双 helper 会话、Windows 本机剩余空间不探测、LocalHost exec 测试 cfg(unix)）
- `docs/00001` / `00002` 和 README 补 Managed Runtime 说明（AGENTS.md 要求）

## 实机暴露的 bug 修复（2026-09-17）

**现象**：真实设备上首次托管运行在 `deploying_uv` 失败，错误 `uv_asset_verification_failed: uv archive contains unexpected file "uv-x86_64-unknown-linux-gnu/uvx"`。

**根因**：官方 uv 发布资产不止含 `uv` 一个文件——unix tar.gz 在同一目录随附 `uvx` 蹦床（x86_64 linux 归档里 `uvx` 排在 `uv` 之前），windows zip 含 `uv.exe` + `uvx.exe` + `uvw.exe`。`unpack_uv` 原先只接受单个 `uv`/`uv.exe` 条目，把合法的伴生文件当额外文件拒绝。⑧ 的 fake 资产只含单个 `uv`，因此内存集成测试拦不住这个形状差异。

**修复**（`runtime/download.rs`）：新增 `ArchiveLayout` 统一校验 tar/zip 条目名——仍然只解出主二进制；伴生文件（`uvx`，windows 再加 `uvw.exe`）允许存在但跳过、不写入目标设备，且必须与主二进制同目录、不得重复；其余额外文件、链接、绝对路径、`..` 照旧拒绝。

**测试**：

- 新增 `unpack_accepts_release_companion_in_either_order`、`unpack_rejects_companion_without_main_outside_dir_and_duplicated`、`unpack_zip_accepts_release_companions`（windows 三件套通过，未知 `.exe` 与重复条目仍拒绝）。
- `fake.rs` 离线资产改为复刻真实归档布局（目录条目 + `uvx` 在前、`uv` 在后），⑧ 的内存集成测试现在覆盖真实资产形状（修复前该资产必然失败）。
- 手工验证：0.12.13 的 4 个真实资产（linux x86_64/aarch64 tar.gz、macOS aarch64 tar.gz、windows x86_64 zip，sha256 与 Catalog 一致）全部解包成功，主二进制长度与归档清单一致（49 388 608 / 42 893 648 / 36 449 104 / 41 556 784 字节）。该临时校验未留在测试套件中，测试默认不依赖公网。

**次日实机复测（2026-09-17，紧随解包修复后）**：部署已能走完解包，但在 `uv --version` 校验处失败，`uv_version_mismatch: deployed uv version mismatch: expected 0.12.13, got "uv 0.12.13 (x86_64-unknown-linux-gnu)\n"`。根因：`uv_version_matches` 要求整行精确等于 `uv 0.12.13`，而真实 uv 输出在版本号后附带括号内的目标三元组。修复（`runtime/prepare.rs`）：改为逐项比较版本号本身——`uv ` 前缀 + 首个空白分隔的版本字段必须等于 Catalog 版本，括号三元组等尾随信息允许；多余版本片段（`0.12.13-dev.1`、`0.12.13.1`、`0.12.130`）一律拒绝。fake uv 的 `--version` 输出也改为复刻真实格式 `uv 0.12.13 (x86_64-unknown-linux-gnu)`，避免⑧ 再用理想化输出掩盖真实二进制的应答形状；新增单测 `uv_version_output_accepts_exact_version_with_target_triple`。

**第三轮实机复测（2026-09-17）**：`uv python install` 通过后，`uv python find` 报错 `managed_python_install_failed: uv python find failed: error: the argument --managed-python cannot be used with --python-preference`。根因：`uv_env` 注入了 `UV_PYTHON_PREFERENCE=only-managed`，而 `find`/`sync` 又显式带 `--managed-python`；uv 0.10+ 把这两处视为同一配置的冲突来源，直接拒绝。在本机用真实 uv（0.10.7）复现：带 env + flag 报同样的错，只带 flag 正常返回 managed 解释器路径。修复（`runtime/prepare.rs`）：`uv_env` 不再注入 `UV_PYTHON_PREFERENCE`，managed-only 约束完全由 `--managed-python` 标志和 `UV_PYTHON_INSTALL_DIR` 表达；`find`/`sync` 的显式标志不变。FakeHost 增加 `exec_env_log`（与 `exec_log` 一一对应），`first_deploy_full_pipeline` 断言全部 exec 的 env 均不含 `UV_PYTHON_PREFERENCE`，把该冲突锁在测试里。00027 §7 的固定环境变量清单同步删除了这一项。

**第四轮实机复测（2026-09-17）**：`uv sync` 报错 `environment_sync_failed: uv sync failed (exit Some(2)): error: Project virtual environment directory ... cannot be used because it is not a valid Python environment (no Python executable was found)`。根因：`prepare_environment_locked` 在调用 `uv sync` 之前主动 `mkdir_all(env_dir)` 并写入 `.preparing` 标记；uv 0.10+ 把已含任何文件的 `UV_PROJECT_ENVIRONMENT` 目录当作"复用现有环境"，发现没有 Python 可执行文件就拒绝。本机真实 uv（0.10.7）复现：空目录可正常 sync，目录里放任意一个文件就稳定报错。修复（`runtime/prepare.rs`）：不再预创建 `env_dir`，也不预写 `.preparing`——uv sync 自己创建环境目录；`.preparing` 只在成功收尾时清理（兼容旧版本残留），恢复路径仍靠"缺失 `.ready` 或 manifest 无效 → 隔离重建"。FakeHost 的 fake uv sync 现在复刻真实行为：`UV_PROJECT_ENVIRONMENT` 指向的目录若已含任何文件，直接按 exit 2 返回同样的错误；新增测试 `sync_rejects_non_empty_env_target` 通过 `run_uv_sync_for_test` 驱动该路径。`sync_failure_keeps_preparing_and_recovers` 相应调整：sync 失败时环境目录可能尚未创建（uv 报错在写盘之前），断言"无 `.ready`"而非"有 `.preparing`"。00027 §12 同步更新事务步骤（去掉预创建/预写 `.preparing`）。

## 遗留清理项（可选）

- `hosts/wsl.rs` 的 `Drop for WslHost` 空实现可简化（靠 Arc drop 杀 bridge）
- `prepare.rs` 的 `runtime_info()` platform 对 posix 返回 "unknown"（仅展示用，可接受）
