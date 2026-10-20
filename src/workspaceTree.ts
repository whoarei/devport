import { WorkspaceEntry } from "./api";

/** 工作区内的相对路径；空字符串代表工作区根目录 */
export type WorkspacePath = string;

export const WORKSPACE_ROOT: WorkspacePath = "";

export interface WorkspaceNode {
  entries: WorkspaceEntry[];
  expanded: boolean;
  loaded: boolean;
  loading?: boolean;
}

export type WorkspaceTree = Record<WorkspacePath, WorkspaceNode>;

export function joinPath(dir: WorkspacePath, name: string): WorkspacePath {
  return dir === WORKSPACE_ROOT ? name : `${dir}/${name}`;
}

export function parentOf(path: WorkspacePath): WorkspacePath {
  const index = path.lastIndexOf("/");
  return index < 0 ? WORKSPACE_ROOT : path.slice(0, index);
}

export function nameOf(path: WorkspacePath): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

/** path 是否等于 dir 或位于 dir 内部 */
export function isWithin(path: WorkspacePath, dir: WorkspacePath): boolean {
  if (path === dir) return true;
  return dir === WORKSPACE_ROOT ? path !== WORKSPACE_ROOT : path.startsWith(`${dir}/`);
}

export function rootTree(entries: WorkspaceEntry[]): WorkspaceTree {
  return { [WORKSPACE_ROOT]: { entries, expanded: true, loaded: true } };
}

/** 更新某个目录节点，保留展开状态 */
export function withNode(
  tree: WorkspaceTree,
  dir: WorkspacePath,
  update: (node: WorkspaceNode | undefined) => WorkspaceNode,
): WorkspaceTree {
  return { ...tree, [dir]: update(tree[dir]) };
}

/** 重命名后把子树缓存整体换到新路径前缀，保留已展开与已加载状态 */
export function rekeySubtree(
  tree: WorkspaceTree,
  oldPath: WorkspacePath,
  newPath: WorkspacePath,
): WorkspaceTree {
  const next: WorkspaceTree = {};
  for (const [key, node] of Object.entries(tree)) {
    next[isWithin(key, oldPath) ? newPath + key.slice(oldPath.length) : key] = node;
  }
  return next;
}

/** 删除后丢弃该路径及其子树的缓存 */
export function dropSubtree(tree: WorkspaceTree, path: WorkspacePath): WorkspaceTree {
  return Object.fromEntries(Object.entries(tree).filter(([key]) => !isWithin(key, path)));
}

/** 递归收集已加载目录中的入口脚本（相对路径） */
export function collectScripts(tree: WorkspaceTree): WorkspacePath[] {
  const scripts: WorkspacePath[] = [];
  for (const [dir, node] of Object.entries(tree)) {
    for (const entry of node.entries) {
      if (entry.is_dir || !/\.(py|sh)$/i.test(entry.name)) continue;
      scripts.push(joinPath(dir, entry.name));
    }
  }
  return scripts.sort((a, b) => a.localeCompare(b));
}
