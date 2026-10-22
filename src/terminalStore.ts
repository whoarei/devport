import { create } from "zustand";
import { api, errorMessage, type TerminalStatus, type WorkspaceRef } from "./api";
import i18n from "./i18n";
import { useAppStore } from "./store";
import { loadTabCycleOrder, saveTabCycleOrder, type TabCycleOrder } from "./tabCycle";

/** 最近使用栈：把 id 移到栈顶 */
const touchMru = (mru: string[], id: string) => [id, ...mru.filter((x) => x !== id)];

export interface TerminalTab {
  id: string;
  deviceId: string;
  deviceName: string;
  /** 当前会话通过 OSC 0/2 提供的标题；不进入恢复快照。 */
  title?: string;
  /** 工作区终端：打开时的工作区来源参数，重连时原样复放 */
  workspace?: { workspace: WorkspaceRef; subdir: string };
  status?: TerminalStatus;
  busy: boolean;
  error?: string;
}

export const terminalActive = (tab: TerminalTab) => tab.busy || !!tab.status &&
  ["connecting", "connected", "closing"].includes(tab.status.state);

const pending = new Set<Promise<unknown>>();
function track<T>(work: Promise<T>): Promise<T> {
  pending.add(work);
  void work.finally(() => pending.delete(work)).catch(() => {});
  return work;
}

interface TerminalStore {
  tabs: TerminalTab[];
  activeTab: string;
  shuttingDown: boolean;
  /** 最近使用栈（含 "run"），头为最新；供 Ctrl+Tab mru 模式切换 */
  mru: string[];
  /** Ctrl+Tab 切换顺序偏好，持久化于 localStorage */
  tabCycleOrder: TabCycleOrder;
  setTabCycleOrder: (order: TabCycleOrder) => void;
  select: (id: string) => void;
  /** MRU 会话中的预览选择：只切换活动标签，松开 Ctrl 后再由 select 提交。 */
  previewSelect: (id: string) => void;
  open: (deviceId: string, deviceName: string, workspace?: { workspace: WorkspaceRef; subdir: string }) => Promise<void>;
  reconnect: (id: string) => Promise<void>;
  close: (id: string) => Promise<void>;
  closeAll: () => Promise<void>;
  update: (id: string, sessionId: string, status: TerminalStatus) => void;
  setTitle: (id: string, sessionId: string, title: string) => void;
  report: (id: string, sessionId: string, error: unknown) => void;
}

/** 按标签参数选择后端入口：工作区终端带 cwd，普通终端用设备默认目录 */
function openSession(deviceId: string, workspace?: { workspace: WorkspaceRef; subdir: string }) {
  return workspace
    ? api.openWorkspaceTerminal(deviceId, workspace.workspace, workspace.subdir)
    : api.openTerminal(deviceId);
}

export const useTerminalStore = create<TerminalStore>((set, get) => {
  const patch = (id: string, value: Partial<TerminalTab>) => set((s) => ({ tabs: s.tabs.map((tab) => tab.id === id ? { ...tab, ...value } : tab) }));
  return {
    tabs: [], activeTab: "run", shuttingDown: false, mru: ["run"], tabCycleOrder: loadTabCycleOrder(),
    setTabCycleOrder: (order) => { saveTabCycleOrder(order); set({ tabCycleOrder: order }); },
    select: (id) => {
      if (id === "run" || get().tabs.some((t) => t.id === id)) set((s) => ({ activeTab: id, mru: touchMru(s.mru, id) }));
    },
    previewSelect: (id) => {
      if (id === "run" || get().tabs.some((t) => t.id === id)) set({ activeTab: id });
    },
    open: (deviceId, deviceName, workspace) => {
      if (useAppStore.getState().updating) return Promise.reject(new Error(i18n.t("run.errorUpdating")));
      if (get().shuttingDown) return Promise.reject(new Error(i18n.t("terminal.closingAll")));
      if (get().tabs.length >= 8) return Promise.reject(new Error(i18n.t("terminal.maxTabs")));
      const id = crypto.randomUUID();
      set((s) => ({ tabs: [...s.tabs, { id, deviceId, deviceName, workspace, busy: true }], activeTab: id, mru: touchMru(s.mru, id) }));
      return track((async () => {
        try { patch(id, { status: await openSession(deviceId, workspace), busy: false }); }
        catch (error) { patch(id, { busy: false, error: errorMessage(error) }); }
      })());
    },
    reconnect: (id) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab || tab.busy || get().shuttingDown || useAppStore.getState().updating || terminalActive(tab)) return Promise.resolve();
      patch(id, { busy: true, error: undefined });
      return track((async () => {
        try {
          if (tab.status) await api.closeTerminal(tab.status.session_id);
          patch(id, { status: undefined, title: undefined });
          patch(id, { status: await openSession(tab.deviceId, tab.workspace), busy: false });
        } catch (error) { patch(id, { busy: false, error: errorMessage(error) }); }
      })());
    },
    close: (id) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab || tab.busy) return Promise.resolve();
      patch(id, { busy: true, error: undefined });
      return track((async () => {
        try {
          if (tab.status) await api.closeTerminal(tab.status.session_id);
          set((s) => {
            const index = s.tabs.findIndex((t) => t.id === id);
            // Prefer the tab to the right, then the one to the left, before falling back to Run.
            const fallback = s.tabs[index + 1]?.id ?? s.tabs[index - 1]?.id ?? "run";
            return {
              tabs: s.tabs.filter((t) => t.id !== id),
              activeTab: s.activeTab === id ? fallback : s.activeTab,
              mru: s.activeTab === id
                ? touchMru(s.mru.filter((x) => x !== id), fallback)
                : s.mru.filter((x) => x !== id),
            };
          });
        } catch (error) { patch(id, { busy: false, error: errorMessage(error) }); }
      })());
    },
    closeAll: async () => {
      set({ shuttingDown: true });
      try {
        await Promise.allSettled([...pending]);
        await api.closeAllTerminals();
        set({ tabs: [], activeTab: "run", mru: ["run"] });
      } finally { set({ shuttingDown: false }); }
    },
    update: (id, sessionId, status) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (tab?.status?.session_id === sessionId) patch(id, { status });
    },
    setTitle: (id, sessionId, title) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (tab?.status?.session_id !== sessionId) return;
      const value = title.trim() || undefined;
      if (tab.title !== value) patch(id, { title: value });
    },
    report: (id, sessionId, error) => {
      if (get().tabs.find((t) => t.id === id)?.status?.session_id === sessionId) patch(id, { error: errorMessage(error) });
    },
  };
});
