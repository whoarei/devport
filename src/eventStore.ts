import { create } from "zustand";
import { errorMessage } from "./api";

export type EventText = string | (() => string);
export interface AppEvent {
  id: string;
  timestamp: number;
  title: EventText;
  message?: EventText;
  level?: "info" | "error";
  dismissible?: boolean;
  action?: { label: EventText; run: () => Promise<boolean | void> };
  actionError?: string;
}

interface EventState {
  events: AppEvent[];
  running: string[];
  add: (event: AppEvent) => void;
  dismiss: (id: string) => void;
  runAction: (id: string) => Promise<void>;
}

/** 通用事件容器；调用方提供文案与动作，恢复类事件可由持久化记录重建。 */
export const useEventStore = create<EventState>((set, get) => ({
  events: [],
  running: [],
  add: (event) => set((state) => ({
    events: [{ ...event, timestamp: Number.isFinite(new Date(event.timestamp).getTime()) ? event.timestamp : Date.now() }, ...state.events.filter((item) => item.id !== event.id)]
      .sort((a, b) => b.timestamp - a.timestamp),
  })),
  dismiss: (id) => set((state) => ({ events: state.events.filter((event) => event.id !== id) })),
  runAction: async (id) => {
    const event = get().events.find((item) => item.id === id);
    if (!event?.action || get().running.includes(id)) return;
    set((state) => ({ running: [...state.running, id] }));
    try {
      const result = await event.action.run();
      // 相同 ID 的新事件不能被旧动作的完成回调移除。
      if (result !== false) set((state) => ({ events: state.events.filter((item) => item !== event) }));
    } catch (error) {
      set((state) => ({ events: state.events.map((item) => item === event ? { ...item, actionError: errorMessage(error) } : item) }));
    } finally {
      set((state) => ({ running: state.running.filter((item) => item !== id) }));
    }
  },
}));

export const eventText = (value: EventText) => typeof value === "function" ? value() : value;
