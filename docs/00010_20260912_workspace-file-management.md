# Workspace 文件管理方案（新建 / 删除 / 重命名 / 目录树）

日期：2026-09-12

状态：已实现（2026-09-12）。第 8 节记录实现结果与方案偏差。

## 1. 背景与目标

Workspace 面板当前只支持选择本地目录、展示顶层一层的扁平文件列表，以及点击文件后编辑保存。后端仅注册了 `list_workspace` / `read_workspace_file` / `write_workspace_file` 三个 command，没有新建、删除、重命名和子目录浏览能力，入口脚本也只能从顶层文件中选择。

本方案为 Workspace 面板增加：

- 新建文件、新建文件夹；
- 重命名文件与目录；
- 删除文件与目录（确认对话框后永久删除，目录递归删除）；
- 目录树展开 / 折叠（替代单层扁平列表，懒加载子目录）；
- 右键上下文菜单交互。

操作对象是**本机工作区目录**。设备上的远端 workspace 在本方案中仍是运行启动时按现有 transport（SSH / Serial / WSL）策略全量上传的临时副本，本方案不改变上传机制、不新增远端文件浏览能力。

> 后续扩展（`docs/00029_20260917_remote-workspace.md`）：工作区来源已扩展为「本机目录或某台设备上的目录」，远端文件浏览 / 编辑与原地运行在本方案之上叠加；本方案描述的本地路径校验、互斥与临时文件替换语义对远端实现同样适用。

## 2. 当前实现与缺口

| 位置 | 当前行为 | 所需变化 |
| --- | --- | --- |
| `src/components/WorkspacePanel.tsx` | 顶层一层扁平列表，目录仅显示图标不可展开 | 重写为可展开的目录树，挂接右键菜单与行内输入 |
| `src/store.ts` | `workspaceFiles` 为扁平数组 | 改为树形状态，新增增删改 action 与打开文件联动 |
| `src/api.ts` | 仅列表 / 读 / 写三个绑定 | 新增 4 个绑定 |
| `src-tauri/src/workspace.rs` | 仅 read / write；`resolve()` 已做路径安全 | 新增 create / rename / delete / list_dir |
| `src-tauri/src/commands.rs` | `blocks_workspace_save()` 只拦截保存 | busy 保护泛化到所有 workspace 变更 |
| `src/components/RunToolbar.tsx` | 从扁平列表过滤 `.py` / `.sh` | 改为递归收集树中的入口脚本 |

可复用的基础：`workspace.rs` 的 `resolve()`（拒绝 `\0`、`:`、`\`、越界、符号链接、Windows reparse point）与 `FILE_OPERATIONS` 全局互斥锁直接适用于新操作；`UnsavedDialog` 的交互样式可作为通用确认对话框的参照。

## 3. 后端设计（Rust）

### 3.1 `src-tauri/src/workspace.rs` 新增函数

全部持有 `FILE_OPERATIONS` 锁，路径校验复用 `resolve()`：

| 函数 | 逻辑 |
| --- | --- |
| `create(root, rel, kind)` | 校验最终组件为 Normal 且父目录 canonical 后仍在 root 内；文件用 `OpenOptions::create_new(true)`（O_EXCL，已存在则报错），目录用 `create_dir`；不隐式创建中间目录 |
| `rename(root, old_rel, new_rel)` | 新旧路径分别校验；目标已存在则拒绝；`fs::rename`；拒绝把目录重命名进自身内部 |
| `delete(root, rel)` | 校验后文件走 `remove_file`，目录走 `remove_dir_all`（递归）；拒绝删除 root 本身 |
| `list_dir(root, subdir)` | 列出指定子目录一层，供树展开；跳过 `.` 开头条目与符号链接（防止目录树循环），目录在前排序 |

### 3.2 名称与路径校验规则

在 Rust 边界校验（与 AGENTS.md 规则一致，不依赖前端校验）：

- 新名称非空，不含 `/ \ : \0`，不是 `.` / `..`，不以 `.` 开头（与列表隐藏规则一致；契约文件 `.python-version` 除外，见 00027 §5），长度不超过 255；
- create / rename 目标已存在时返回可区分的 `exists` 错误，前端据此给出明确提示；
- 路径非法、目标不存在、无权限等错误分类返回，与现有 read / write 错误风格一致。

### 3.3 与运行流程的互斥

现有 `blocks_workspace_save()` 只在 run 处于 preparing / syncing / stopping 时拦截保存。泛化为：**该期间所有 workspace 变更（create / rename / delete / write）一律返回 busy 错误**，防止同步扫描与工作区内容变化交错导致上传不一致。读和列表不加此限制。该方法实现时更名为 `blocks_workspace_change()`。

### 3.4 新 Tauri command

在 `commands.rs` 实现、`lib.rs` 注册：

```text
create_workspace_entry(dir, name, kind)   // kind: "file" | "dir"
rename_workspace_entry(dir, old_name, new_name)
delete_workspace_entry(dir, name)
list_workspace_dir(dir, subdir)           // 树展开用
```

`list_workspace` 由 `list_workspace_dir(dir, "")` 取代：旧 command 已从后端移除，前端与测试的调用点全部改为新接口。

## 4. 前端设计

### 4.1 `src/api.ts`

新增上述 4 个 invoke 绑定与类型；`WorkspaceEntry` 维持 `{ name, is_dir }`，路径由前端按树节点拼接为相对路径传给后端。

### 4.2 `src/store.ts`

- `workspaceFiles` 扁平数组改为树形状态：以相对路径为键的节点映射（`entries` / `expanded` / `loaded`），根节点在 `setWorkspaceDir` 时加载；
- 新 action：`toggleDir`（懒加载子目录）、`createEntry` / `renameEntry` / `deleteEntry`，成功后局部刷新受影响节点而不是整树重载；
- 沿用 `loadSequence` 竞态防护：切换工作区后作废进行中的展开 / 变更响应；
- **打开文件联动**（00017 起按多标签处理：受影响的所有标签）：
  - 删除或重命名打开中的文件：若有未保存修改先弹确认（复用现有 dirty 检查）；删除后关闭对应标签，重命名后更新标签路径与文档身份；
  - 删除或重命名包含打开文件的目录：对子树内所有打开的标签同上处理；
- busy 错误（运行同步中）以可见提示呈现，不静默失败。

### 4.3 `src/components/WorkspacePanel.tsx`

- 递归渲染目录树：目录可展开 / 折叠，文件点击打开到编辑器；
- **右键上下文菜单**：自绘 React 组件，不引入新依赖；按目标类型显示菜单项：
  - 空白区 / 目录：新建文件、新建文件夹；（目录另有）重命名、删除；
  - 空白区另有（后续新增）：打开工作区…、关闭工作区、最近的工作区（扁平列出
    用于切换），与「文件」菜单同源——打开 / 切换走 `openWorkspace()`，关闭走
    `setWorkspaceDir(null)`，均复用未保存确认；
  - 文件：打开、重命名、删除；
  - 未打开工作区时（后续新增）：打开工作区…、最近的工作区（扁平列出
    `recentWorkspaces`，无记录时显示置灰的「（无最近记录）」），与「文件」菜单同源，
    均走 `openWorkspace()`；
- 新建 / 重命名使用**行内输入框**（Enter 确认、Esc 取消、失焦取消）；删除使用通用确认对话框（新增 `ConfirmDialog.tsx`，参照 `UnsavedDialog` 样式；目录删除提示将递归删除全部内容）；
- 菜单全局点击 / Esc 关闭；样式加入 `styles.css`。

### 4.4 `src/components/RunToolbar.tsx`

入口脚本下拉从扁平列表过滤改为**递归收集树中已加载节点的 `.py` / `.sh`**（含子目录相对路径）；`RunRequest.entry` 仍为工作区内相对路径，后端 runner 的现有 entry 校验（拒绝 `..` / 符号链接 / 越界）不变。未展开的子目录不加载，脚本不在已加载范围内时不出现在下拉框——入口选择退化场景与现状一致（当前也只能选顶层）。

## 5. 测试与验证

- **Rust 单元测试**（`workspace.rs` 内 `#[cfg(test)]`，临时目录）：create 重名拒绝、`..` / NUL / 绝对路径 / 符号链接拒绝、rename 到已存在目标拒绝、目录 rename 进自身拒绝、delete 递归删除与 root 保护、list_dir 跳过符号链接；
- **前端测试**（`tests/`，node --test，mock api）：store 的 create / rename / delete / toggleDir action、树展开状态、打开文件被删除或重命名时的编辑器联动、dirty 确认分支；
- 验证命令：

```powershell
# 仓库根目录
npm test
npm run build
git diff --check

# src-tauri 目录
cargo fmt --all -- --check
cargo test --offline --all-targets
```

## 6. 改动文件清单

| 文件 | 改动 |
| --- | --- |
| `src-tauri/src/workspace.rs` | +create / rename / delete / list_dir 及单元测试 |
| `src-tauri/src/commands.rs` | +4 个 command；busy 保护泛化到全部变更操作 |
| `src-tauri/src/lib.rs` | 注册新 command |
| `src/api.ts` | +4 个绑定与类型 |
| `src/store.ts` | 树形状态 + 4 个 action + 打开文件联动 |
| `src/components/WorkspacePanel.tsx` | 目录树 + 右键菜单 + 行内输入 |
| `src/components/ConfirmDialog.tsx` | 新增通用确认对话框 |
| `src/components/RunToolbar.tsx` | 入口脚本递归收集 |
| `src/styles.css` | 树 / 菜单 / 行内输入样式 |
| `tests/` | store action 测试 |
| `docs/` | 本方案文档；实施后在实施记录中同步 |

## 7. 明确不做

- 不改变远端上传机制（仍为 run 启动时按现有策略全量同步）；不新增设备侧远端文件浏览；
- 不引入回收站依赖，删除为确认后永久删除；
- 不做拖拽移动文件、多选、复制粘贴（可作为后续扩展）；
- 不放宽 Serial / WSL / SSH 现有上传策略限制；新建的文件仍受各 transport 上传校验约束（如 Serial 仅 UTF-8 文本）。

## 8. 实施记录（2026-09-12）

### 8.1 落地内容

后端（`src-tauri/src/`）：

- `workspace.rs`：新增 `EntryKind` / `Entry` 类型与 `create` / `rename` / `delete` / `list_dir`；抽出 `canonical_root()`（原 `resolve()` 的根校验部分）供新旧路径共用；`From<io::Error>` 增加 `AlreadyExists → "exists"` 映射。
- `commands.rs`：`list_workspace` 由 `list_workspace_dir(dir, subdir)` 取代（列目录为只读操作，不取 `FILE_OPERATIONS` 锁，run 同步期间仍可浏览）；新增 `create_workspace_entry` / `rename_workspace_entry` / `delete_workspace_entry`，三者与 `write_workspace_file` 共用 `blocked_by_run()` 检查。
- `process.rs`：`RunState::blocks_workspace_save()` 更名为 `blocks_workspace_change()`，语义扩展到全部本地工作区变更。
- `lib.rs`：注册 4 个新 command，移除 `list_workspace`。

前端（`src/`）：

- `workspaceTree.ts`（新增）：相对路径工具（`joinPath` / `parentOf` / `nameOf` / `isWithin`）与树缓存操作（`rootTree` / `withNode` / `rekeySubtree` / `dropSubtree` / `collectScripts`），纯函数便于测试。
- `store.ts`：`workspaceFiles` 扁平数组改为 `workspaceTree: Record<相对目录路径, { entries, expanded, loaded }>`；新增 `loadWorkspaceDir` / `toggleWorkspaceDir` / `createWorkspaceEntry` / `renameWorkspaceEntry` / `deleteWorkspaceEntry` / `dismissWorkspaceError`，以及 `workspaceError`、`workspaceMutating` 状态；用独立的 `workspaceSequence` 在切换工作区后作废在途目录加载与变更响应。
- `WorkspacePanel.tsx`：递归目录树 + 右键上下文菜单（自绘，无新依赖）+ 行内输入（Enter 提交 / Esc 或失焦取消，重命名时只选中主文件名）+ 面板内错误条。
- `ConfirmDialog.tsx`（新增）：props 驱动的通用确认对话框，删除走 `danger` 按钮。
- `RunToolbar.tsx`：入口脚本改为 `collectScripts(workspaceTree)` 递归收集（含子目录相对路径）。
- `styles.css`：`.file-tree` / `.tree-row` / `.tree-chevron` / `.tree-name` / `.tree-input` / `.context-menu` / `.menu-item-danger` / `.workspace-error` / `.workspace-empty`；`.confirm-dialog` 复用 `.unsaved-dialog` 样式；移除已废弃的 `.file-list li > button`。

测试与验收夹具：

- `tests/workspace.test.ts`（新增）：路径与树缓存纯函数、根加载与懒展开只读一次、新建后刷新父目录与错误透传、同步中拒绝全部变更、重命名迁移打开文档 / 入口草稿 / 子树缓存、删除的未保存确认与编辑器关闭、切换工作区丢弃在途请求。
- `scripts/test.mjs`：改为按入口名数组打包，纳入 `workspace.test.ts`。
- `tests/editor-browser.tsx`：内存 mock 补齐 `listWorkspaceDir` / `create` / `rename` / `delete`（含子目录 `sub/nested.py`），并加上“模拟同步中”按钮用于验证变更互斥；同时修正夹具缺失的 `WorkspacePanel` / `RunConsole` props。

### 8.2 与方案的偏差和补充

- 名称校验比方案更严格：额外拒绝 Windows 保留设备名（`CON` / `PRN` / `AUX` / `NUL` / `COM1-9` / `LPT1-9`，不区分大小写、忽略扩展名）、控制字符、`* ? " < > |`、以空格或 `.` 结尾的名称；隐藏条目（`.` 开头）在 `list_dir` 中跳过，也不能作为新建 / 重命名目标，避免出现面板里看不见的条目。例外：Managed Python 契约要求的 `.python-version` 在白名单中，可列出、新建、编辑、重命名与删除。
- 重命名不重挂载编辑器：`documentGeneration` 保持不变以保留撤销历史，只更新 `openFile`、语言与入口草稿；仅删除打开文件时才关闭编辑器并递增代次。
- 目录重命名采用“子树缓存改键”（`rekeySubtree`）而非丢弃缓存，展开状态与已加载内容得以保留；删除则丢弃该子树缓存（`dropSubtree`）。
- 删除的未保存确认复用既有 `confirmUnsaved()`（保存 / 放弃 / 取消），因此选择“保存并继续”时会先写盘再删除；重命名不丢内容，故不触发该确认。
- 入口脚本下拉只包含**已加载**目录中的脚本：未展开过的子目录不会出现在下拉框中，与方案一致。
- 目录展开/折叠始终可点击，只有“打开文件”和增删改在 `loading` / `saving` / `starting` / `guarding` / `workspaceMutating` 期间禁用。

### 8.3 验证结果

```text
cargo fmt --all -- --check          通过（无输出）
cargo test --offline --all-targets  lib 58 passed / 0 failed / 7 ignored（WSL 集成测试为 opt-in）
                                    tests/ssh_lifecycle 5 passed
npm test                            31 passed / 0 failed（store + layout + review + workspace）
npm run build                       tsc + vite 构建通过
```

`workspace.rs` 的 Windows 符号链接用例在本机具备创建权限，未跳过。本次改动不涉及传输层协议，串口 duplex 模拟器与本地 shell 冒烟测试无回归；SSH / 物理串口实机验证未执行（无可用硬件）。目录树、右键菜单与行内输入的桌面手工验收待用户在 `npm run tauri dev` 中确认（本项目禁止使用 Computer Use 代做界面验收）。
