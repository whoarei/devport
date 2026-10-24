import { create } from "zustand";
import { errorMessage } from "./api";

export type EventText = string | (() => string);
export interface AppEvent {
  id: string;
  timestamp: number;
  title: EventText;
  message?: EventText;
  level?: "info" | "error";
  remove?: () => Promise<void>;
  action?: { label: EventText; run: () => Promise<boolean | void> };
  actionError?: string;
}

interface EventState {
  events: AppEvent[];
  running: string[];
  clearing: boolean;
  add: (event: AppEvent) => void;
  dismiss: (id: string) => void;
  remove: (id: string) => Promise<void>;
  clear: () => Promise<void>;
  runAction: (id: string) => Promise<void>;
}

/** 通用事件容器；调用方提供文案与动作，恢复类事件可由持久化记录重建。 */
export const useEventStore = create<EventState>((set, get) => {
  const operate = async (event: AppEvent, action: () => Promise<boolean | void>) => {
    if (!get().events.includes(event) || get().running.includes(event.id)) return;
    set((state) => ({ running: [...state.running, event.id] }));
    try {
      const result = await action();
      // 相同 ID 的新事件不能被旧操作的完成回调移除。
      if (result !== false) set((state) => ({ events: state.events.filter((item) => item !== event) }));
    } catch (error) {
      set((state) => ({ events: state.events.map((item) => item === event ? { ...item, actionError: errorMessage(error) } : item) }));
    } finally {
      set((state) => ({ running: state.running.filter((item) => item !== event.id) }));
    }
  };
  return {
    events: [],
    running: [],
    clearing: false,
    add: (event) => set((state) => ({
      events: [{ ...event, timestamp: Number.isFinite(new Date(event.timestamp).getTime()) ? event.timestamp : Date.now() }, ...state.events.filter((item) => item.id !== event.id)]
        .sort((a, b) => b.timestamp - a.timestamp),
    })),
    // Internal reconciliation only; user deletion must run the saved-data callback.
    dismiss: (id) => set((state) => ({ events: state.events.filter((event) => event.id !== id) })),
    remove: async (id) => {
      const event = get().events.find((item) => item.id === id);
      if (event && !get().clearing) await operate(event, () => event.remove?.() ?? Promise.resolve());
    },
    clear: async () => {
      if (get().clearing) return;
      const events = get().events.filter((event) => !get().running.includes(event.id));
      set({ clearing: true });
      try {
        for (const event of events) await operate(event, () => event.remove?.() ?? Promise.resolve());
      } finally {
        set({ clearing: false });
      }
    },
    runAction: async (id) => {
      const event = get().events.find((item) => item.id === id);
      if (event?.action && !get().clearing) await operate(event, event.action.run);
    },
  };
});

export const eventText = (value: EventText) => typeof value === "function" ? value() : value;
