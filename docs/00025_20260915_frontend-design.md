# 00025 前端总体设计

日期：2026-09-15
状态：已实现（现状梳理；布局与面板注册细节以 00022 为准，i18n 以 00020 为准）

## 概述

前端是 Remote Runner 的全部 UI，运行在 Tauri WebView 中，通过 `invoke` 命令与
Rust 后端通信。职责边界：前端只做展示、编辑与交互编排；所有安全校验（路径包
含、设备输入、运行参数）都在 Rust 边界完成，前端校验只是体验优化。

技术栈：

| 类别 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript（`React.StrictMode`） |
| 构建 | Vite（`npm run build` = `tsc && vite build`） |
| 状态 | Zustand（两个独立 store：app / terminal） |
| 编辑器 | CodeMirror 6（python / shell / text，one-dark 高亮） |
| 终端 | xterm.js + fit addon |
| i18n | i18next + react-i18next（zh / en，内联资源） |
| 桌面能力 | `@tauri-apps/api`（window / event / core）、plugin-dialog、plugin-opener、plugin-autostart |
| 测试 | esbuild 打包 `tests/*.test.ts` 后由 `node --test` 运行（`scripts/test.mjs`） |

## 目录结构

```
src/
├── main.tsx              # 入口：挂 i18n、样式，渲染 <App/>
├── App.tsx               # 根组件：dock 布局渲染、run 事件订阅、关闭守卫、更新检查
├── api.ts                # 唯一的 IPC 边界：invoke 封装 + 事件轮询 + 类型定义
├── store.ts              # 主 store（设备 / 工作区 / 编辑器标签 / run / 历史 / 布局）
├── terminalStore.ts      # 终端标签页 store（独立于主 store）
├── panels/
│   ├── registry.tsx      # 面板元数据注册表（id / dock / i18n key / 图标 / 默认可见）
│   └── components.ts     # 面板 id → 懒加载组件映射（统一 PanelComponentProps）
├── components/           # 全部 UI 组件（面板、对话框、标题栏、菜单、分割条）
├── i18n/                 # zh.ts（键源）/ en.ts（类型约束同键）/ language.ts（偏好）
├── styles.css            # 全局样式
└── <纯逻辑模块>.ts        # 见「纯逻辑模块」一节
```

## 架构分层

自上而下四层，依赖方向严格单向（组件 → store → 纯逻辑模块 → api）：

1. **组件层**（`components/`）：只做渲染与用户事件转发。面板组件通过
   `PANEL_COMPONENTS` 懒加载接入，props 统一为
   `{ visible, collapsed, onToggleCollapse }`。
2. **状态层**（`store.ts`、`terminalStore.ts`）：Zustand store，持有全部共享状
   态与异步动作（加载、保存、启动运行、事件归并）。组件用 selector 订阅
   （多字段时用 `useShallow`），避免无关渲染。
3. **纯逻辑模块层**：无 React、无 IPC 的可单测函数（见下节）。
4. **API 层**（`api.ts`）：全部 `invoke` 调用、请求/响应类型、事件轮询泵。

### 设备配置对话框

`DeviceDialog` 使用原生 `<dialog>` 管理模态焦点，打开后聚焦设备名称，支持 Esc 关闭。
SSH、串口、WSL、本机 Shell 通过图标卡片切换，连接字段按组排列；工作区根目录、
默认设备和适用的 USB 共享入口放在可展开的「更多设置」中。标题与底部操作栏固定，
表单内容独立滚动；窄窗口使用两列连接卡片与单列表单。新增文案均提供中英文翻译。

### 面板注册（00022）

- `panels/registry.tsx` 只含元数据，不 import 组件实现，保证 `layoutState.ts`
  可以安全引用而不产生模块循环。
- `panels/components.ts` 用 `lazy()` 关联组件：既打破
  registry → 组件 → store → layoutState → registry 的循环，也让编辑器 / 终端
  等重组件按需载入（`<Suspense>` 包裹）。
- 新增面板 = registry 加一项 + components 加一行；dock 渲染、视图菜单、标题
  栏切换按钮、布局持久化全部自动适配。
- 两个 dock：`sidebar`（Workspace / Commands / Runtime 堆叠，左/右可换位）与
  `center`（Editor / Console 平等结构，按 `splits.center` 分高）。

## 纯逻辑模块

这些模块是前端可测试性的核心：不含 DOM 与 IPC 依赖，`tests/` 直接对其单测。

| 模块 | 职责 |
| --- | --- |
| `layoutState.ts` | `LayoutState` 模型、clamp、`normalizeLayout`（坏数据逐字段回落 + v1 旧键迁移）、localStorage 读写 |
| `runState.ts` | run 活跃判定、状态乱序防御（`newestStatus`）、`RunDraft` 草稿模型、状态文案 |
| `outputBuffer.ts` | run 输出环形缓冲：单 run 2 MiB / 全局 16 MiB / 4096 chunk 上限，`appendOutput` / `trimOutput`，`gaps` 计数 |
| `consoleReplay.ts` | 把 store 里的输出缓冲按位置增量回放进 xterm，单飞行写、run 切换 reset、gap 触发全量重放 |
| `editorDocument.ts` | 编辑器标签模型（content / savedContent / revision / eol / bom / generation）、脏判定、语言推断、关标签后的邻居选择 |
| `workspaceTree.ts` | 目录树缓存（相对路径 → 节点）的纯操作：join / parent / isWithin / withNode / rekeySubtree / dropSubtree / collectScripts |
| `workspaceHistory.ts` | 最近工作区列表（localStorage，去重，上限 10） |
| `workspacePicker.ts` | 目录选择对话框 → `setWorkspaceDir` 的编排（依赖 store，属边界编排层） |
| `presetCommands.ts` | 预置命令模型与 normalize（数量 / 名称 / 命令长度 / 超时上限），localStorage 持久化 |
| `terminalIO.ts` | 交互终端读取泵：xterm 消费完上一批才 drain 下一批，隐藏页共用同一泵，出错退避 1s |
| `appLifecycle.ts` | 统一退出流程：前置到前台 → 忙/脏守卫 → 未保存确认 → 关闭全部终端 → `destroy()` |
| `updateStatus.ts` | 更新展示态纯逻辑：安装阻塞判定（忙 / 脏 / 有活跃 run）、按钮文案、进度格式化、`installWithProgress` |
| `updateFlow.ts` | 一键更新 / 对话框安装编排：订阅 `app-update://progress`、portable 回退手动下载 |
| `autostart.ts` | tauri-plugin-autostart 的启用状态读写封装 |

## IPC 与数据流

### 命令调用

`api.ts` 中的 `api` 对象是全部 `invoke` 的唯一出口，按域分组：设备
（list/save/delete/test、串口 / WSL 发行版 / 本机 shell 枚举）、工作区文件
（list/read/write/create/rename/delete）、运行（run_script / stop / input /
resize / status / history）、交互终端（open / read / input /
resize / close）、应用更新（check / install）。

约定：

- 输出字节经后端 base64 编码过事件边界，前端用 `base64ToBytes` 还原后直接写
  xterm，保证原始字节不被文本化破坏。
- `errorMessage()` 统一把未知错误压成可展示字符串。
- 所有用户可见错误文案走 i18n（模块内直接 `i18n.t()`，组件内 `useTranslation()`）。

### run 事件：拉模式轮询（`onRunEvents`）

前端不用原生事件推送 run 输出，而是约 33ms 轮询 `drain_run_events`：

- **单飞行**：`drainInFlight` promise 链保证同一时刻只有一个未消费的 IPC 响
  应，慢/隐藏 WebView 不会累积无界的原生事件投递。
- **StrictMode 安全**：cleanup 置 `disposed` 后不再续订；下一个订阅者等前一
  个飞行响应被消费后才开始 drain。
- **resync 语义**：后端检测事件缺口时下发 `resync`，前端整体替换 runs /
  history，并对所有缓冲 `gaps + 1`（跨缺口字节绝不拼接，含 UTF-8/ANSI 半字
  符），由 `consoleReplay` 触发终端全量重放。

事件归并进 store 在 `handleRunEvents`：output → 追加缓冲；status →
`newestStatus` 防乱序倒退后并入 runs，终态条目进入 history（上限 200）；最后
`pruneRuns` 统一执行保留集（活跃 run + 选中回看 + 历史 + 至多 32 个 pending
缓冲）与总字节预算裁剪（先裁旧的已完成 run，活跃 run 次之，选中 run 最后），
并 `consoleSeq + 1` 通知控制台重绘。

### 交互终端：读泵（`terminalIO.readTerminal`）

每个终端页一条轮询泵：`read_terminal` 返回 `{ status, data }`，data 写完
xterm（await write 回调）才发下一次读；有数据立即续读、无数据 33ms 间隔；终
态（exited/closed/failed）且无未读数据时停泵。状态与错误经
`terminalStore.update/report` 按 `session_id` 校验后落库，避免旧会话串台。

## 状态管理

### `useAppStore`（store.ts）

单一主 store，域划分：

- **设备**：`devices` / `selectedDeviceId` / `editingDevice`（null = 对话框关闭）。
- **工作区**：`workspaceDir`、`workspaceTree`（目录树缓存）、`recentWorkspaces`、
  `workspaceMutating` / `workspaceError`。
- **编辑器**：`openTabs`（打开顺序即标签顺序）、`activeFile`、`changePrompt`
  （未保存确认对话框的 resolve 句柄）。
- **运行**：`runs` / `outputBuffers` / `activeRunId` / `consoleSize` /
  `consoleSeq` / `history` / `runDraft`。
- **布局**：`layout`，`setLayout` 每次 patch 都先 `normalizeLayout` 再落盘。
- **全局互斥标志**：`loading` / `saving` / `starting` / `guarding` / `updating`。

关键并发控制：

1. **序列号守卫**：`loadSequence`（文件/工作区读取）与 `workspaceSequence`
   （目录变更）两个模块级计数器。异步响应回来时序列号不匹配（期间发生了新
   的加载或工作区切换）则整体丢弃，杜绝旧响应覆盖新状态。
2. **generation 守卫**：保存响应只在标签 `generation` 未变（没有被关闭/重读）
   时合并，重读会 `generation + 1`。
3. **忙标志互斥**：保存 / 启动运行 / 未保存确认 / 工作区变更前都检查
   `loading|saving|starting|guarding`（以及 `uploadBusy`），冲突时给出 i18n
   提示而不是排队。
4. **启动运行前置**（`startRun`）：拒绝更新中、文件忙、工作区已切换
   （`request.workspace_dir !== workspaceDir`）、目标缺失；先 `saveAllDirty`
   再 `run_script`；invoke 返回前事件可能已到，缺状态时补拉
   `get_run_status`，再兜底合成 `preparing` 状态，保证「保存中」不会有窗口期。

### `useTerminalStore`（terminalStore.ts）

交互终端标签独立成 store：`tabs`（上限 8）/ `activeTab`（`"run"` 为运行控制
页）/ `shuttingDown`。模块级 `pending` 集合跟踪所有飞行中的开关操作，
`closeAll` 先 `allSettled(pending)` 再调 `close_all_terminals`，保证退出路径
不会与单页操作竞态。

## 关键子域设计

### 工作区文件与编辑器

- 目录树按需加载：首次展开才 `list_workspace_dir`，缓存节点
  `{ entries, expanded, loaded }`；重命名走 `rekeySubtree` 改键并联动打开标
  签、活动文件与运行入口草稿；删除走 `dropSubtree` 并对受影响的脏标签逐个弹
  未保存确认。
- 文档模型保留 `eol` / `bom` / `revision`：保存时带 `expectedRevision`，后端
  检出冲突返回 `code === "conflict"`，标签置 `conflict` 供 UI 提示重读。
- 未保存确认（`confirmUnsaved`）以 promise + `changePrompt` 实现：置
  `guarding` 冻结输入，对话框选择 save / discard / cancel 后 resolve；
  `confirmAllUnsaved` 串行遍历所有脏标签，用于关工作区、删目录、退出与更新。
- 打开/激活文件自动 `revealEditor`：编辑区隐藏或折叠时恢复显示并展开。

### 运行控制台（RunConsole + consoleReplay）

- xterm 实例常驻（center dock 用 `hidden` 属性隐藏面板而不卸载，编辑器与终
  端实例保活，切回零成本）。
- 回放器只信 store：`consoleSeq` 变化时泵一次，按 `buffer.start + index` 位
  置续写；run 切换时 reset 并打印灰色标题行；`gaps` 变化时从后端可回放快照
  全量重放。
- 控制台尺寸经 `setConsoleSize` 记录，随 `run_script` 一起下发（cols/rows）。

### 控制台任务状态

- history 由事件流终态条目与 `loadRuns`（live + saved 快照合并，按 ended_at
  排序，上限 200）维护；快照拉取期间到达的事件用 `newestStatus` 保护不被旧
  快照覆盖。
- 2026-10-19 移除侧栏运行历史面板、菜单项、分割条、导出与清空流程及专用 IPC。
  控制台继续使用上述状态缓存、日志回放和任务选择，工作区历史命令独立保留。

### 应用生命周期

- 关闭窗 = 隐藏到托盘：`onCloseRequested` 一律 preventDefault + hide，不触发
  任何未保存守卫；`beforeunload` 仅作 WebView 兜底。
- 真退出（托盘菜单 / 文件→退出）经 `tray://quit-requested` 事件进入
  `requestQuit()`：前置窗口 → 忙/更新中直接拒绝 → `confirmAllUnsaved` →
  `closeAll` 终端 → `destroy()`，`quitting` 标志防重入。

### 应用更新

- 启动静默 `check_app_update`，有新版点亮标题栏「更新」按钮（失败不打扰）。
- 安装前 `updateInstallBlocker` 检查忙 / 脏 / 活跃 run / 活跃终端；安装经
  `installWithProgress` 订阅 `app-update://progress` 展示下载进度 →
  verifying → installing；Windows 上安装成功即进程退出，invoke 正常返回反而
  视为「安装程序未接管」报错。
- portable 形态（`can_auto_install === false`）回退打开浏览器手动下载。

## i18n（00020）

- `zh.ts` 为键源，`en.ts` 类型约束为同键集合，编译期防漏译。
- 语言偏好 `zh | en | system` 持久化于 localStorage，`system` 按
  `navigator.language` 探测；切换即时生效并同步 `<html lang>`。
- 组件用 `useTranslation()`；纯逻辑模块 import `i18n` 实例直接 `t()`。

## 持久化键一览（localStorage）

| 键 | 内容 | 归一化 |
| --- | --- | --- |
| `remote-runner.layout.v1` | 布局（面板显隐/折叠、侧栏宽/位、splits） | `normalizeLayout`，含 v1 旧字段迁移 |
| `remote-runner.recent-workspaces.v1` | 最近工作区（≤10） | 去重、类型过滤 |
| `remote-runner.presets.v1` | 预置命令（≤100） | `normalizePresets`，长度/超时 clamp |
| `remote-runner.language.v1` | 语言偏好 | 非法值回落 `system` |

原则：所有从 localStorage 读入的数据都视为不可信，逐字段校验回落默认值，
绝不因坏数据崩溃。

## 测试

`npm test`：esbuild 把 `tests/*.test.ts` 打包成 CJS 后交给 `node --test`。
覆盖 store 动作序列、布局归一化/迁移、输出缓冲与回放、工作区树操作、预置命
令、工作区历史命令、更新流程、终端泵、设备表单等纯逻辑；浏览器相关行为另有
`tests/editor-browser.html` 手动验证页与 `.editor-native-check`。约定：测试
不依赖 Tauri 运行时（`api` 可注入 mock），不依赖真实设备。

## 设计原则汇总

1. **单向依赖 + 纯逻辑外置**：能提出 store/组件的算法一律进纯模块，可单测。
2. **IPC 拉模式 + 单飞行**：输出与终端都靠有界轮询，慢前端不会压垮后端。
3. **原始字节保真**：base64 直达 xterm，缺口绝不拼接字节。
4. **状态守卫三件套**：序列号、generation、忙标志，所有异步合并前校验。
5. **隐藏不卸载**：center dock 面板用 `hidden` 保活重组件实例。
6. **不可信持久化**：localStorage 数据一律 normalize。
7. **UI 字符串全走 i18n**，zh 为键源。
