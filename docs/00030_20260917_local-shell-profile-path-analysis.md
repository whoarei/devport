# 问题分析报告：应用内 PowerShell 找不到 `opencode`（profile PATH 与 `\\?\` 路径）

- 日期：2026-09-17
- 影响范围：本机 Shell（`transport: "local"`）的交互终端、命令运行、脚本运行、连接测试
- 结论：**不是 PATH 拼接错误，而是"PowerShell profile 是否加载"这一决策被硬编码在多个入口里，且各入口的取值不一致**；附带发现 canonical 路径的 `\\?\` 前缀被直接交给了 shell
- 相关文档：`00023_20260913_local-shell.md`（设计）、`00024_20260913_local-shell-implementation.md`（实现与踩坑）

## 1. 现象

在应用内的本机 pwsh 终端执行 `opencode`：

```
PS Microsoft.PowerShell.Core\FileSystem::\\?\D:\安视讯\测试> opencode
opencode: 术语 'opencode' 不会被识别为 cmdlet、函数、脚本文件或可执行程序的名称。
```

同一个 `opencode` 在 Windows Terminal 里正常运行。注意提示符里的两处异常：`Microsoft.PowerShell.Core\FileSystem::` 前缀和 `\\?\` 路径。

## 2. 排查过程与证据

全部证据来自同一台机器（Windows，pwsh 7），命令与输出可复现。

1. **`opencode` 是什么**：`where opencode` 在普通 shell 里也找不到；最终定位到它是 fnm 管理的 Node 里的 npm 全局 shim：

   ```
   C:\Users\xishu\AppData\Roaming\fnm\node-versions\v24.14.0\installation\opencode.cmd / .ps1
   C:\Users\xishu\AppData\Roaming\fnm\node-versions\v15.14.0\installation\opencode.cmd / .ps1
   ```

2. **注册表 PATH 里没有它**：`reg query HKCU\Environment` 的 Path 与 HKLM 系统 Path 都不含任何 fnm 的 Node 目录（只有 fnm 自己的 winget 目录）。

3. **profile 才是它的 PATH 来源**：`Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1` 里有 `fnm env --use-on-cd | Out-String | Invoke-Expression`。带 profile 时：

   ```
   opencode.ps1 ExternalScript C:\Users\xishu\AppData\Local\fnm_multishells\67244_1789640216360\opencode.ps1
   node.exe     Application    C:\Users\xishu\AppData\Local\fnm_multishells\67244_1789640216360\node.exe
   npm.ps1      ExternalScript C:\Users\xishu\AppData\Local\fnm_multishells\67244_1789640216360\npm.ps1
   ```

   fnm 给**每个 shell** 生成一个独立目录并前插到 PATH。

4. **对照实验**（同一台机器、同一目录）：`pwsh -Command` 下 `opencode`/`node`/`npm` 全部解析成功；`pwsh -NoProfile -Command` 下三者**全部 NOT FOUND**；而 `cargo`、`gh`、`bun`、`python` 在 `-NoProfile` 下仍然正常（它们位于注册表 PATH 中）。丢的不是整个 PATH，而是 profile 注入的那一段。

5. **端到端复现**：用一个最小 Rust 程序按应用的方式 spawn pwsh（cwd 用 `canonicalize` 的产物），结果与用户报告完全一致：

   ```
   canonical cwd = "\\\\?\\D:\\安视讯\\测试"
   --- args=["-NoProfile"] ---  opencode -> NOT FOUND
   --- args=[]            ---  opencode -> C:\Users\xishu\AppData\Local\fnm_multishells\67244_1789640216360\opencode.ps1
   ```

6. **`\\?\` 的来源**：`std::fs::canonicalize("D:\安视讯\测试")` 在 Windows 上返回 verbatim 形式 `\\?\D:\安视讯\测试`（实测确认）。两处把 canonical 路径直接交给了 shell：
   - `workspace::terminal_dir` 的返回值成为终端 cwd（`commands::open_workspace_terminal`）；
   - `runner::validate_request` 把 canonical 工作区回写成 `RunRequest.workspace`（运行 cwd、msys 入口路径、界面路径）。

   附带验证：Git Bash（`bash -lc pwd`）与 `cmd /C cd` 能容忍 verbatim cwd（Git 运行时自己去掉了前缀），所以这主要是提示符与路径可读性问题，但 `to_msys_path` 对 `\\?\E:\a\b` 会拼出 `//?/E:/a/b` 这种不存在的入口路径。

## 3. 根因

### 3.1 profile 提供的 PATH 被 `-NoProfile` 掐掉（主要问题）

应用所有本机 PowerShell 调用都硬编码了 `-NoProfile`：交互终端 `local/terminal.rs`、命令与脚本 `local/mod.rs::invocation`、连接测试 `local/mod.rs::test_device`。而 fnm/nvm/conda 这类工具**只通过 profile 注入 PATH**，注册表里没有它们的痕迹，所以：

- 应用内（`-NoProfile`）看不到 npm 全局命令、`node`、`npm`；
- Windows Terminal（加载 profile）看得到。

`portable-pty` 在 Windows 上会用注册表 PATH（HKLM + HKCU 拼接）重建子进程环境块，因此注册表级 PATH 一直是对的——缺的恰好是只能由 profile 提供的那部分。同时这是**跨平台不一致**：posix 分支刻意用 `-l`/`-li` 让 `/etc/profile` 提供完整 PATH，还注入 `CHERE_INVOKING` 保住 cwd，只有 PowerShell 分支把提供 PATH 的环节掐掉了。

### 3.2 canonical 的 `\\?\` 前缀进了 shell（次要问题）

`canonicalize` 是路径安全校验（containment、符号链接、组件合法性）的正确工具，但它的产物被直接当成 shell cwd / 入口路径使用。PowerShell 无法把 verbatim 路径映射到盘符，于是提示符退化成 `Microsoft.PowerShell.Core\FileSystem::\\?\D:\...`；MSYS2/Git Bash 的路径转换也会产出不存在的 `//?/...`。

## 4. 影响面

| 入口 | 原来的行为 | 现在 |
|---|---|---|
| 交互终端（工作区/独立） | 硬编码 `-NoProfile` → profile PATH 不可见 | 读 `local.no_profile` |
| Command 运行 | 硬编码 `-NoProfile` | 读同一开关 |
| Shell 脚本运行（`-File`） | 硬编码 `-NoProfile` | 读同一开关 |
| 连接测试 | 硬编码 `-NoProfile` | 读同一开关 |
| 运行 cwd / 终端 cwd | canonical（`\\?\`）形式 | 常规形式 |

## 5. 修复方案与决策记录

1. **一个开关，四个入口共用**：`local: { shell, path?, no_profile? }`，`Shell` 解析时带上该字段，argv 只由 `local::profile_args()` 决定是否加 `-NoProfile`（交互终端、Command、Script、连接测试都调用它）。默认 `false` = 加载 profile。

   默认取"加载"的理由：这是让用户报告的现象消失的唯一默认值（与 Windows Terminal 行为一致），且与 posix 的 `-l`/`-li` 语义对齐——本仓库已经把"profile 提供 PATH"当作 posix 的既定做法。想要确定性运行的场景（profile 有横幅输出、需要可复现脚本输出）可以在设备配置里勾选开关，代价是只有注册表 PATH 里的命令可用。

   *备选与翻转方式*：若希望默认保持旧的确定性行为，只需把 `LocalConfig.no_profile` 的默认值与前端 `emptyDevice()` 改为 `true`（一行），四个入口无需改动。

2. **路径形式分层**：校验继续用 canonical 形式，交给外部（shell cwd、运行请求工作区）之前统一经 `verbatim::simplify` 还原。只还原盘符形式与 `\\?\UNC\` 形式；设备路径（`Volume{GUID}`、`GLOBALROOT`）、达到 MAX_PATH、以及去掉前缀会改变含义的路径（尾随点/空格、DOS 保留名）原样保留，绝不改变路径含义。

## 6. 改动清单

- `src-tauri/src/verbatim.rs`（新增）：`simplify()` 与单元测试。
- `src-tauri/src/device.rs`：`LocalConfig.no_profile`（`serde(default)`），配置校验测试覆盖缺省/显式两种解析。
- `src-tauri/src/local/shells.rs`：`Shell.no_profile`，由 `resolve()` 带入。
- `src-tauri/src/local/mod.rs`：`profile_args()`（唯一出口）、`probe_args()`（抽出连接测试命令行）、`invocation()` 的两个 PowerShell 分支改为经由 `profile_args`。
- `src-tauri/src/local/terminal.rs`：交互终端经 `profile_args`（`interactive_args` 提升为 `pub(super)` 以便测试）。
- `src-tauri/src/workspace.rs`：`terminal_dir` 返回常规形式。
- `src-tauri/src/runner.rs`：回写 `RunRequest.workspace` 前 `verbatim::simplify`。
- 前端：`api.ts` 类型、`DeviceDialog.tsx` 复选框（默认不勾选）、`zh.ts`/`en.ts` 文案。
- 测试：`local/tests.rs::profile_switch_is_shared_by_every_local_powershell_entry_point`（四个入口一致性）、`device.rs` 与 `tests/device.test.ts` 的配置往返、`workspace.rs::terminal_dir_...`（不再返回 `\\?\`）。
- 文档：`00023`（配置、argv 表、工作区路径形式）、`00024`（模块清单、踩坑记录）。

## 7. 验证

- `cargo fmt --all -- --check`、`cargo test --offline --all-targets`：新增的开关一致性与路径还原测试通过；`every_detected_shell_runs_echo` 现在覆盖"加载 profile"这一出厂默认（本机实测 pwsh/powershell/cmd/msys2/gitbash）。
- `npm test`、`npm run build`：前端模板与 i18n 断言通过。
- 手工复现：按"2.5"的方式 spawn 带开关的 pwsh，确认开/关两种模式下 `Get-Command opencode` 的结果符合预期。

## 8. 剩余风险

- **profile 会影响非交互运行**：默认加载后，带横幅输出或交互提示的 profile 会污染 Command/Script 运行的输出、甚至让运行等待输入。这是"与用户真实 shell 一致"的代价，开关可关掉；是否要为运行单独提供覆盖（例如每次运行一个 `--no-profile` 选项）留待后续需求。
- **还原 verbatim 前缀可能改变极少数路径的含义**：仅靠"尾随点/空格 + DOS 保留名 + MAX_PATH"三道守卫兜住；出现新的 verbatim-only 形态时需要补充守卫而不是放宽。
- 未改动的地方：Managed Runtime（uv）的 Python 解释器路径仍可能是 verbatim 形式，但它是直接 spawn 的程序路径（不是 cwd，也不经 shell），无需还原。
