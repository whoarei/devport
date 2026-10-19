# 运行历史导出与输出持久化设计

日期：2026-09-12

状态：历史设计。2026-10-19 已移除侧栏运行历史面板、视图菜单入口、记录/日志导出与清空功能，以及对应前后端接口和测试。本文保留原设计供追溯；下述导出与清空行为不再适用。

运行控制台的任务切换、状态恢复和输出回放仍使用 RunManager 的状态与日志存储（200 条、每次输出 2 MiB 的既有限额及自动淘汰规则保持）。工作区 `.runner/commands.json` 中的历史命令独立保留。旧布局中的 `history` 面板设置与侧栏高度分割比例在读取时丢弃，其他布局偏好继续保留。

## 1. 目标与范围

在历史面板中右键某条历史记录，可导出：

- **导出记录 (JSON)**：该条 `RunStatus` 元数据，所有历史条目可用；
- **导出输出日志 (.log)**：该次运行的输出内容。

为支撑旧会话条目也能导出输出，运行输出从本次起**持久化到本地磁盘**（此前输出只经内存事件通道推送，见 `00013`）。范围不含批量导出、不含远端工作区清理。

## 2. 输出持久化

- 位置：`config_dir/run_logs/<run_id>.log`，由 `RunManager`（`src-tauri/src/runner.rs`）管理。
- 写入时机：`emit_output` 在推送前端事件的同时，把**原始字节**追加写入日志文件（惰性创建）。stdout/stderr 按到达顺序合并为一个文件，与现有单流回看语义一致；不保证 UTF-8。
- 单 run 上限 `RUN_LOG_LIMIT = 2 MiB`（与前端单 run 输出缓冲 `MAX_OUTPUT_BYTES` 对齐）：超限后停止追加并记 `truncated`，运行本身不受影响。
- `RunStatus` 增加 `output_bytes: u64` / `output_truncated: bool`（均 `#[serde(default)]`，旧 `history.json` 兼容，旧条目为 0）；`finish()` 时从 `RunHandle` 的计数落入状态。
- 写入失败仅忽略并停止该 run 的后续落盘，不影响运行与事件推送。

## 3. 日志生命周期（配合既有 `HISTORY_LIMIT = 200`）

历史条数已有 200 条上限（启动 `truncate` + `finish()` 中 `pop_back`）。日志必须随历史淘汰，否则 `run_logs/` 无限增长；最坏磁盘占用 200 × 2 MiB ≈ 400 MB：

1. `finish()` 淘汰：从历史尾部 `pop_back()` 掉的条目，同步删除其 `.log`；
2. 启动截断：`truncate(HISTORY_LIMIT)` 被截掉的条目，删除其 `.log`；
3. 孤儿清理：启动时扫描 `run_logs/`，删除不在历史中的 `.log` 文件（防止崩溃残留）。文件名严格匹配 `<run_id>.log`、run_id 仅 `[A-Za-z0-9_-]`，不递归、不碰其他文件。

## 4. 导出命令（Rust 边界）

文件落盘统一在 Rust 完成（前端无 fs 插件）：

- `export_run_record(path, contents)`：校验 path 非空、`contents` 不超过 32 MiB，`std::fs::write` 落盘。内容由前端拼好（JSON）。
- `export_run_output(run_id, path)`：校验 `run_id` 字符集（防路径穿越），`std::fs::copy` 日志文件到目标路径，保持原始字节不加头；无日志返回错误。
- `clear_run_history()`：清空全部历史——删除所有历史条目的输出日志、清空内存历史并把 `history.json` 写为 `[]`；运行中的任务及其日志不受影响（其日志在结束后随新一轮淘汰管理）。写盘失败向前端报错。

目标路径来自系统保存对话框（`@tauri-apps/plugin-dialog`，`dialog:default` 已含 `allow-save`），用户取消返回 null 时静默结束。

## 5. 前端

- 抽取 `WorkspacePanel` 的 `ContextMenu`/`MenuEntry`/`MenuState` 到 `src/components/ContextMenu.tsx` 复用；`MenuEntry` 增加 `disabled?: boolean` 支持单项置灰。
- `HistoryPanel` 历史条目加 `onContextMenu`：
  - 「导出记录 (JSON)」始终可用；
  - 「导出输出日志 (.log)」仅 `output_bytes > 0` 可用，否则置灰（旧会话条目自然置灰）。
- 面板空白区右键提供「清空历史记录」（危险项，历史为空时置灰），经 `ConfirmDialog` 二次确认后调 `clear_run_history`，前端同步清空历史列表并裁剪已完成 run 的内存状态与输出缓冲。
- 新增 `src/historyExport.ts`：`defaultExportName`（清洗 Windows 非法文件名字符、拼时间戳）、`buildRecordJson`、`exportRecord`/`exportOutput` 流程函数；失败在历史面板内提示，`output_truncated` 时提示日志为截断部分。

### 2026-10-14 界面简化

- 运行中与已完成记录统一为单行任务名；已完成记录右侧显示时分。
  状态只通过起始色点区分，非零退出码使用错误颜色，不在列表中展示状态或退出码文字。
  设备名称、完整状态、退出码、时间、错误、uv / Python 版本和环境 ID 保留在悬停提示及 JSON
  导出中；回看按钮的无障碍标签保留设备及状态信息。
- 当前选中记录高亮；点击可回看的记录自动显示并展开控制台。旧会话记录不显示
  可点击的回看交互，但仍可导出记录及已有日志。
- 条目「更多」按钮提供导出，标题栏「更多」按钮提供清空；原有右键菜单保留，
  清空仍需确认。运行中的任务始终保留停止入口，包括面板折叠时。
- 历史操作错误直接显示在历史面板内，避免编辑区隐藏时看不到反馈。

## 6. 测试与验证

- Rust：日志落盘与 2 MiB 截断、写入失败不影响运行、两条淘汰路径 + 孤儿清理、旧格式 `history.json` 兼容、导出命令的路径/字符集校验与缺失日志报错。
- 前端 `tests/historyExport.test.ts`：文件名清洗、JSON 构建、菜单置灰逻辑、取消保存不报错。
- 验证：`npm test`、`npm run build`、`cargo fmt --all -- --check`、`cargo test --offline --all-targets`、`git diff --check`。
