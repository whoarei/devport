/**
 * Ctrl+Tab 标签循环切换的纯逻辑与顺序偏好持久化。
 * 无 store 依赖，便于单测；副作用编排在 consoleTabs.ts。
 */

/** 切换顺序：sequential 按标签栏左右顺序；mru 按最近使用栈 */
export type TabCycleOrder = "sequential" | "mru";

const STORAGE_KEY = "remote-runner.tab-cycle-order.v1";

/** 读取持久化的顺序偏好；缺省或非法值回落 sequential。 */
export function loadTabCycleOrder(): TabCycleOrder {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    return raw === "mru" ? "mru" : "sequential";
  } catch {
    return "sequential";
  }
}

export function saveTabCycleOrder(order: TabCycleOrder): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, order);
  } catch (error) {
    console.warn("Unable to save tab cycle order", error);
  }
}

/** 左右顺序：在 ids 中定位 current，±1 取模循环；找不到时回落第一项。 */
export function nextSequentialId(ids: string[], current: string, reverse: boolean): string {
  if (ids.length === 0) return current;
  const index = ids.indexOf(current);
  if (index === -1) return ids[0];
  return ids[(index + (reverse ? -1 : 1) + ids.length) % ids.length];
}

/**
 * 生成一次标准 MRU 切换会话的稳定快照：当前标签在首位，其后保持最近使用顺序，
 * 尚未进入 MRU 的现存标签按标签栏顺序补到末尾。
 */
export function mruCycleOrder(ids: string[], mru: string[], current: string): string[] {
  const available = new Set(ids);
  const order: string[] = [];
  const append = (id: string) => {
    if (available.has(id) && !order.includes(id)) order.push(id);
  };
  append(current);
  for (const id of mru) append(id);
  for (const id of ids) append(id);
  return order;
}

/**
 * 在一次稳定的 MRU 快照中，forward 取 current 的下一项，reverse 取上一项；均循环。
 * current 不在栈中时回落到最近的其它项。
 */
export function nextMruId(mru: string[], current: string, reverse: boolean): string {
  if (mru.length === 0) return current;
  const index = mru.indexOf(current);
  if (index === -1) return mru.find((id) => id !== current) ?? current;
  return mru[(index + (reverse ? -1 : 1) + mru.length) % mru.length];
}
