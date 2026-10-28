import { localWorkspace, WorkspaceRef, workspaceRefEquals } from "./api";

const STORAGE_KEY_V1 = "devport.recent-workspaces.v1";
const STORAGE_KEY = "devport.recent-workspaces.v2";
const MAX_RECENT_WORKSPACES = 10;

/** 解析单个条目：v2 标记对象，或 v1 裸字符串（本机目录，自动迁移） */
function parseEntry(value: unknown): WorkspaceRef | null {
  if (typeof value === "string") return value.trim() ? localWorkspace(value) : null;
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.type === "local" && typeof record.dir === "string" && record.dir.trim()) {
    return localWorkspace(record.dir);
  }
  if (
    record.type === "device" &&
    typeof record.device_id === "string" && record.device_id.trim() &&
    typeof record.path === "string" && record.path.startsWith("/")
  ) {
    return { type: "device", device_id: record.device_id, path: record.path };
  }
  return null;
}

function normalizeHistory(value: unknown): WorkspaceRef[] {
  if (!Array.isArray(value)) return [];
  const entries: WorkspaceRef[] = [];
  for (const item of value) {
    const parsed = parseEntry(item);
    if (parsed && !entries.some((existing) => workspaceRefEquals(existing, parsed))) entries.push(parsed);
  }
  return entries.slice(0, MAX_RECENT_WORKSPACES);
}

export function loadWorkspaceHistory(): WorkspaceRef[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored != null) return normalizeHistory(JSON.parse(stored));
    // v1（裸字符串数组）迁移为 v2 的 Local 条目
    const legacy = localStorage.getItem(STORAGE_KEY_V1);
    if (legacy == null) return [];
    const migrated = normalizeHistory(JSON.parse(legacy));
    if (migrated.length) saveWorkspaceHistory(migrated);
    localStorage.removeItem(STORAGE_KEY_V1);
    return migrated;
  } catch {
    return [];
  }
}

export function saveWorkspaceHistory(workspaces: WorkspaceRef[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaces));
  } catch (error) {
    console.warn("Unable to save recent workspaces", error);
  }
}

export function rememberWorkspace(workspaces: WorkspaceRef[], workspace: WorkspaceRef): WorkspaceRef[] {
  return normalizeHistory([workspace, ...workspaces]);
}
