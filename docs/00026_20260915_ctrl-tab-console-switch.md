# Ctrl+Tab 在运行控制台与终端标签间切换

## 目标与边界

为底部控制面板区的标签（固定的「运行控制台」+ 各终端标签）提供全局快捷键循环切换：
Ctrl+Tab 切到下一个，Ctrl+Shift+Tab 切到上一个。切换顺序支持两种模式并可配置：

- **左右顺序（sequential，默认）**：按标签栏排列顺序 `["run", ...tabs]` 取模循环，
  与既有方向键导航语义一致、可预测。
- **最近使用（mru）**：采用与 VS Code 类似的标准 MRU 会话。第一次按下
  Ctrl+Tab 时冻结当前 MRU 顺序；保持 Ctrl 按下并继续按 Tab / Shift+Tab 时，
  在同一份快照中正向 / 反向遍历；松开 Ctrl 后才把最终标签提交到 MRU 栈顶。

没有终端标签（只有运行控制台）时快捷键为 no-op。不改变串口设备禁止开终端、
终端上限 8 个等既有约束；不涉及编辑器标签的切换。

## 交互

- Ctrl+Tab 由 window 级 capture `keydown` 统一处理，并同时调用
  `preventDefault()` / `stopPropagation()`。capture 阶段早于 xterm 的 textarea
  handler，因此无论焦点位于编辑器、工具栏还是 xterm，一次物理按键都只切换一次，
  且不会向远端发送 TAB 字节。允许键盘 repeat，保持 Ctrl+Tab 时可以连续遍历。
- window capture `keyup` 在 Control 松开时提交 MRU 会话；窗口失焦及组件卸载也会
  提交并清理会话，避免快照跨越一次组合键操作残留。
- 切换后确保控制面板区可见且未折叠（复用 `panelVisibilityPatch` /
  `panelCollapsePatch`，与「+ 打开终端时自动展开」的既有先例一致）。
- 焦点跟随：终端标签变为可见且已连接时自动聚焦（既有行为）；运行控制台补充
  「变为可见时聚焦其 xterm」，保证连续 Ctrl+Tab 时焦点始终落在当前标签内。
- 配置入口：菜单「视图 → Ctrl+Tab 切换顺序」submenu，两个 checkbox
  （左右顺序 / 最近使用），仿「侧栏位置」submenu 的既有模式。

## 前端结构

- `src/tabCycle.ts`：纯逻辑 + 偏好持久化，无 store 依赖，可直接单测。
  - `TabCycleOrder = "sequential" | "mru"`；
    localStorage key `remote-runner.tab-cycle-order.v1`（裸字符串，非法值回落
    `sequential`，仿 `i18n/language.ts` 模式）。
  - `nextSequentialId(ids, current, reverse)`：取模 ±1 循环。
  - `mruCycleOrder(ids, mru, current)`：生成一次稳定、去重且包含全部现存标签的
    MRU 快照，当前标签固定在第一项，MRU 中缺失的新标签按标签栏顺序补到末尾。
  - `nextMruId(order, current, reverse)`：在稳定快照中定位 current，forward 取
    下一项、reverse 取上一项（均循环）。
- `src/terminalStore.ts`：新增 `tabCycleOrder` / `setTabCycleOrder`（保存并更新）
  与 `mru: string[]`（最近使用栈，头为最新，初始 `["run"]`）。
  `select` / `open` 把目标 id 移到栈顶；`close` 从栈中移除该 id，若关闭的是
  活动标签则回落 `"run"` 并置于栈顶；`closeAll` 重置为 `["run"]`；
  `previewSelect` 只改变活动标签，用于 MRU 会话中的预览。
- `src/consoleTabs.ts`：`cycleConsoleTab(reverse)` 管理模块级 MRU 会话并计算下一项；
  MRU 预览调用 `previewSelect`，`endConsoleTabCycle()` 在 Ctrl 松开时调用 `select`
  提交最终项；`handleConsoleTabKeyDown()` / `handleConsoleTabKeyUp()` 是唯一 DOM
  按键入口。切换后确保 console 面板可见且未折叠。
- 挂载点：
  - `App.tsx`：window capture `keydown` / `keyup` 与 `blur` useEffect；组件卸载时
    同样结束尚未提交的会话。
  - `RunConsole.tsx` / `TerminalPage.tsx`：不再各自处理 Ctrl+Tab，避免与全局入口
    重复执行；各自的 Ctrl+C、复制 / 粘贴语义保持不变。
  - `RunConsole.tsx`：`collapsed` 变为 false 时 `termRef.current?.focus()`。
- i18n：`zh.ts` menu 块新增 `tabCycleOrder` / `tabCycleSequential` /
  `tabCycleMru`，`en.ts` 由 `typeof zh` 约束强制补齐。

## 验证

- 前端单测（`tests/terminal.test.ts`，node --test）：
  - `nextSequentialId` / `mruCycleOrder` / `nextMruId` 的快照、正反向、回绕与回落；
  - mru 栈在 select / open / close / closeAll 下的维护；
  - `cycleConsoleTab` 两种模式、MRU 快照遍历、Ctrl 松开后提交与无终端时 no-op；
  - capture handler 对一次 Ctrl+Tab 恰好执行一次切换，并调用 preventDefault /
    stopPropagation；
  - 偏好非法值回落 `sequential`。
- `npm test`、`npm run build`、`git diff --check`；纯前端改动，不涉及 cargo。
- WebView2 中 Ctrl+Tab 能到达 DOM keydown（无原生菜单加速键冲突，应用为自绘
  MenuBar）；合入前仍需在 `npm run tauri dev` 中手工确认按键、焦点与 repeat 手感。

## 实施状态

设计已确定并已实现：全局单入口 Ctrl+Tab / Ctrl+Shift+Tab、标准 MRU 会话、
sequential/mru 双模式与菜单配置项、运行控制台自动聚焦、前端单元测试。
