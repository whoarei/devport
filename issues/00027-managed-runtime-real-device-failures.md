# 00027 Managed Python Runtime：实机部署四轮失败分析

> 基线：`de7cdcd`（master）。以下为真实设备上按顺序暴露的四个问题，全部位于 uv-only Managed Python Runtime（`docs/00005-python-runtime.md`）的部署链路。

## 共性根因

四处失败属于同一类：**fake / test double 按理想化契约编写，真实 uv 的行为不同**——归档形状、`--version` 输出格式、CLI/env 冲突规则、`UV_PROJECT_ENVIRONMENT` 目录非空拒绝。修复时每处都让 fake 复刻真实 uv，并在单测里钉住对应行为，保证回归可重现。

## 失败序列

| # | 阶段 | 错误码 | 直接原因 |
|---|---|---|---|
| 1 | 部署 uv | `uv_asset_verification_failed` | 官方归档含 `uvx` 伴生文件，解包器只接受单个 `uv` 条目 |
| 2 | 部署 uv | `uv_version_mismatch` | `uv --version` 输出带括号三元组，比较器要求整行精确等于 `uv 0.12.13` |
| 3 | 安装 Python | `managed_python_install_failed` | `UV_PYTHON_PREFERENCE=only-managed` 与显式 `--managed-python` 在 uv 0.10+ 冲突 |
| 4 | 同步依赖 | `environment_sync_failed` | `uv sync` 前预写 `.preparing` 标记，`UV_PROJECT_ENVIRONMENT` 非空被 uv 拒绝 |

### 1. uv 归档伴生文件（`runtime/download.rs`）

- **现象**：`uv archive contains unexpected file "uv-x86_64-unknown-linux-gnu/uvx"`。
- **验证**：下载 0.12.13 的 4 个真实资产（linux x86_64/aarch64 tar.gz、macOS aarch64 tar.gz、windows x86_64 zip，sha256 与 Catalog 一致），linux/macos tar.gz 同目录含 `uv` + `uvx`（x86_64 linux 中 `uvx` 在前），windows zip 含 `uv.exe` + `uvx.exe` + `uvw.exe`。
- **修复**：`ArchiveLayout` 分类条目——主二进制仍只解出 `uv`/`uv.exe`；伴生文件（`uvx`，windows 另有 `uvw.exe`）允许存在但跳过、不写入目标设备，且必须与主二进制同目录、不得重复；其余额外文件、链接、绝对路径、`..` 照旧拒绝。
- **测试**：`unpack_accepts_release_companion_in_either_order`、`unpack_rejects_companion_without_main_outside_dir_and_duplicated`、`unpack_zip_accepts_release_companions`；`fake.rs` 离线资产改为复刻真实归档布局。

### 2. `uv --version` 输出带目标三元组（`runtime/prepare.rs`）

- **现象**：部署后版本校验失败，实际输出为 `uv 0.12.13 (x86_64-unknown-linux-gnu)`。
- **修复**：`uv_version_matches` 改为逐项比较——`uv ` 前缀 + 首个空白分隔的版本字段必须精确等于 Catalog 版本；括号三元组允许；多余版本片段（dev、第四段、前导零扩展如 `0.12.130`）拒绝。
- **测试**：`uv_version_output_accepts_exact_version_with_target_triple`；fake uv 的 `--version` 输出复刻真实格式。

### 3. `UV_PYTHON_PREFERENCE` 与 `--managed-python` 冲突（`runtime/prepare.rs`）

- **现象**：`uv python find 3.12.9 --managed-python` 报 `the argument --managed-python cannot be used with --python-preference`。
- **本机复现**（真实 uv 0.10.7）：带 `UV_PYTHON_PREFERENCE=only-managed` 复现该错误；去掉 env 后正常返回 managed 解释器路径。
- **修复**：`uv_env` 不再注入 `UV_PYTHON_PREFERENCE`；managed-only 约束由 `--managed-python` 标志 + `UV_PYTHON_INSTALL_DIR` 表达。`find`/`sync` 的显式标志不变。
- **测试**：FakeHost 增加 `exec_env_log`，`first_deploy_full_pipeline` 断言所有 exec 的 env 不含 `UV_PYTHON_PREFERENCE`。

### 4. `UV_PROJECT_ENVIRONMENT` 非空目录被 uv 拒绝（`runtime/prepare.rs`）

- **现象**：`uv sync` 报 `... is not a valid Python environment (no Python executable was found)`。
- **本机复现**（真实 uv 0.10.7）：空目录可正常 sync；目录里预写任何文件（含 `.preparing`）即稳定报错。
- **根因**：`prepare_environment_locked` 在 `uv sync` 之前 `mkdir_all(env_dir)` 并写入 `.preparing`，uv 把非空 `UV_PROJECT_ENVIRONMENT` 当作"复用现有环境"，发现没有 Python 可执行文件就拒绝。
- **修复**：不再预创建 `env_dir`，也不预写 `.preparing`；环境目录由 uv sync 自己创建。`.preparing` 仅在成功收尾时幂等清理（兼容旧版本残留）。恢复路径仍靠"缺失 `.ready` 或 manifest 无效 → 隔离重建"，语义不变。
- **测试**：fake uv `sync` 复刻该行为（env 目录非空即 exit 2）；新增 `sync_rejects_non_empty_env_target` 通过 `run_uv_sync_for_test` 驱动该路径；`sync_failure_keeps_preparing_and_recovers` 改为断言"无 `.ready`"而非"有 `.preparing`"。

## 验证范围

- `cargo test --offline --lib`：171 通过 / 0 失败（10 个 WSL opt-in 忽略）。
- `npm test`：107 通过；`npm run build`（含 tsc）通过。
- `cargo fmt --all -- --check`、`git diff --check` 通过；`cargo check --offline --all-targets` 零警告。
- 应用运行时 `target/debug/remote-runner.exe` 被占用，`cargo test --offline --all-targets` 无法链接 exe，以完整 lib 套件 + `cargo check --all-targets` 代替。

## 遗留观察

四处修复均没有真机端到端自动化覆盖（prepare_runtime + 真实 uv + 一次 sync）。若要进一步拦截同类问题，可加一个 opt-in 的真实 uv 冒烟测试（gating 方式与 WSL 集成测试一致），在到达设备前暴露契约偏差。本次未引入，因为它会默认依赖网络。
