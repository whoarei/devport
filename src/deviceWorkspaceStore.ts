import { createStore } from "zustand/vanilla";
import { deviceWorkspace, errorMessage, isRemoteWorkspaceHost, type DeviceProfile, type WorkspaceRef } from "./api";
import { transferApi, type TransferEntry } from "./transferApi";
import { joinPath, parentOf } from "./workspaceTree";
import { canBrowseDevicePath } from "./directoryCompletion";
import i18n from "./i18n";
import { deviceWorkspaceDirectories, rememberDeviceWorkspaceDirectory } from "./deviceWorkspaceDirectories";

export function deviceWorkspaceKey(device: DeviceProfile | null | undefined): string | null {
  return device && isRemoteWorkspaceHost(device)
    ? JSON.stringify([device.id, device.revision, device.transport, device.workspace_root]) : null;
}

export interface DeviceWorkspaceNode {
  entries: TransferEntry[];
  expanded: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

export interface DeviceWorkspaceState {
  key: string | null;
  root: WorkspaceRef | null;
  tree: Record<string, DeviceWorkspaceNode>;
  generation: number;
  navigating: boolean;
  mutating: boolean;
  error: string | null;
  follow: (device: DeviceProfile | null | undefined) => Promise<void>;
  refresh: () => Promise<void>;
  load: (dir: string) => Promise<void>;
  toggle: (dir: string) => Promise<void>;
  navigate: (path: string) => Promise<boolean>;
  resetRoot: () => Promise<boolean>;
  refreshBranch: (dir: string) => Promise<void>;
}

const emptyNode = (): DeviceWorkspaceNode => ({ entries: [], expanded: true, loading: false, loaded: false, error: null });
export const deviceWorkspaceNode = (tree: DeviceWorkspaceState["tree"], dir: string) => Object.prototype.hasOwnProperty.call(tree, dir) ? tree[dir] : undefined;

/** Each mounted sidebar owns its reads, independently of the editor and transfer browser. */
export function createDeviceWorkspaceStore(directories = deviceWorkspaceDirectories) {
  let generation = 0;
  let configuredRoot: WorkspaceRef | null = null;
  const reads = new Map<string, object>();
  return createStore<DeviceWorkspaceState>((set, get) => ({
    key: null, root: null, tree: {}, generation: 0, navigating: false, mutating: false, error: null,
    follow: async (device) => {
      ++generation;
      const key = deviceWorkspaceKey(device);
      configuredRoot = key && device ? deviceWorkspace(device.id, device.workspace_root) : null;
      const root = key && device ? deviceWorkspace(device.id, directories.get(device.id) ?? device.workspace_root) : null;
      reads.clear();
      set((s) => ({ key, root, tree: {}, generation: s.generation + 1, navigating: false, mutating: false, error: null }));
      if (configuredRoot) await get().load("");
    },
    refresh: async () => {
      const root = get().root;
      if (!root || get().mutating) return;
      ++generation;
      reads.clear();
      set((s) => ({ root, tree: {}, generation: s.generation + 1, navigating: false, error: null }));
      await get().load("");
    },
    navigate: async (path) => {
      if (!configuredRoot || configuredRoot.type !== "device" || get().mutating) return false;
      const value = path.trim();
      if (!canBrowseDevicePath(value)) { set({ error: i18n.t("deviceWorkspace.invalidPath") }); return false; }
      const token = ++generation;
      reads.clear();
      set((s) => ({ navigating: true, error: null, generation: s.generation + 1,
        tree: Object.fromEntries(Object.entries(s.tree).map(([path, node]) => [path, { ...node, loading: false }])) }));
      try {
        const directory = await transferApi.listWithin(deviceWorkspace(configuredRoot.device_id, value), "");
        if (token !== generation) return false;
        rememberDeviceWorkspaceDirectory(directories, directory.endpoint);
        set({ root: directory.endpoint, navigating: false, tree: { "": { ...emptyNode(), loaded: true, entries: sortedEntries(directory.entries) } } });
        return true;
      } catch (error) {
        if (token === generation) {
          set({ navigating: false, error: errorMessage(error) });
          // Resume expanded reads invalidated by a failed navigation.
          for (const [dir, node] of Object.entries(get().tree)) {
            if (token !== generation) break;
            if (node.expanded && !node.loaded) await get().load(dir);
          }
        }
        return false;
      }
    },
    resetRoot: async () => configuredRoot?.type === "device" ? get().navigate(configuredRoot.path) : false,
    refreshBranch: async (dir) => {
      if (!get().root) return;
      const within = (path: string) => path === dir || (!dir ? !!path : path.startsWith(`${dir}/`));
      for (const path of reads.keys()) if (within(path)) reads.delete(path);
      set((s) => ({ generation: s.generation + 1, tree: {
        ...Object.fromEntries(Object.entries(s.tree).filter(([path]) => !within(path))),
        [dir]: { ...emptyNode() },
      } }));
      await get().load(dir);
    },
    load: async (dir) => {
      const { root, tree } = get();
      if (!root || get().navigating || deviceWorkspaceNode(tree, dir)?.loading) return;
      // Only traverse directory entries returned by the parent listing.
      if (dir && !deviceWorkspaceNode(tree, parentOf(dir))?.entries.some((entry) => entry.kind === "dir" && joinPath(parentOf(dir), entry.name) === dir)) return;
      const token = generation;
      const read = {};
      reads.set(dir, read);
      set((s) => ({ tree: { ...s.tree, [dir]: { ...(deviceWorkspaceNode(s.tree, dir) ?? emptyNode()), loading: true, error: null } } }));
      try {
        const directory = await transferApi.listWithin(root, dir);
        if (token !== generation || reads.get(dir) !== read) return;
        const entries = sortedEntries(directory.entries);
        if (!dir) rememberDeviceWorkspaceDirectory(directories, directory.endpoint);
        set((s) => ({
          root: dir ? s.root : directory.endpoint,
          tree: { ...s.tree, [dir]: { ...s.tree[dir], entries, loading: false, loaded: true, error: null } },
        }));
      } catch (error) {
        if (token === generation && reads.get(dir) === read) set((s) => ({ tree: { ...s.tree, [dir]: { ...s.tree[dir], loading: false, error: errorMessage(error) } } }));
      } finally {
        if (reads.get(dir) === read) reads.delete(dir);
      }
    },
    toggle: async (dir) => {
      if (get().navigating || get().mutating) return;
      const node = deviceWorkspaceNode(get().tree, dir);
      const expanded = !node?.expanded;
      set((s) => ({ tree: { ...s.tree, [dir]: { ...(deviceWorkspaceNode(s.tree, dir) ?? emptyNode()), expanded } } }));
      if (expanded && !node?.loaded) await get().load(dir);
    },
  }));
}

function sortedEntries(entries: TransferEntry[]) {
  return entries.filter((entry) => entry.kind === "dir" || entry.kind === "file")
    .sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export type DeviceWorkspaceStore = ReturnType<typeof createDeviceWorkspaceStore>;
