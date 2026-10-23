import { type WorkspaceRef } from "./api";
import { appendEndpoint, endpointPath, transferApi, type TransferDirectory } from "./transferApi";

export function isDevicePath(path: string): boolean {
  return path.startsWith("/") && !/[\0\r\n]/.test(path) && !path.split("/").some((part) => part === "." || part === "..");
}

export function canBrowseDevicePath(path: string): boolean {
  return isDevicePath(path) || (path.startsWith("~/") && isDevicePath(path.slice(1)));
}

export function parentDevicePath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

export function joinDevicePath(path: string, name: string): string {
  return `${path.replace(/\/+$/, "")}/${name}`;
}

export function endpointWithPath(endpoint: WorkspaceRef, path: string): WorkspaceRef {
  return endpoint.type === "local" ? { type: "local", dir: path } : { ...endpoint, path };
}

/** Complete one path component; never list the unfinished path itself. */
export function directoryCompletionQuery(endpoint: WorkspaceRef, value: string) {
  if (/[\0\r\n]/.test(value)) return null;
  const windows = endpoint.type === "local" && (/^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value));
  const separators = windows ? /[\\/]/ : /\//;
  if (!windows && !(endpoint.type === "device" ? canBrowseDevicePath(value) : isDevicePath(value))) return null;
  if (value.split(separators).some((part) => part === "." || part === "..")) return null;
  const cut = windows ? Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) : value.lastIndexOf("/");
  if (cut < 0) return null;
  let parent = value.slice(0, cut + 1);
  // A UNC host is not a directory; wait until a share is supplied.
  if (windows && /^\\\\/.test(value) && parent.split(/[\\/]/).filter(Boolean).length < 2) return null;
  if (parent !== "/" && parent !== "~/" && !/^[a-z]:[\\/]$/i.test(parent)) parent = parent.slice(0, -1);
  return { endpoint: endpointWithPath(endpoint, parent), prefix: value.slice(cut + 1), windows };
}

export function directorySuggestions(directory: TransferDirectory, prefix: string, windows = false): string[] {
  const needle = windows ? prefix.toLowerCase() : prefix;
  return directory.entries.filter((entry) => entry.kind === "dir"
    && !!entry.name && !/[\/\0\r\n]/.test(entry.name) && ![".", ".."].includes(entry.name)
    && (windows ? entry.name.toLowerCase() : entry.name).startsWith(needle))
    .map((entry) => endpointPath(appendEndpoint(directory.endpoint, entry.name)))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Session-local cache also coalesces requests while a parent listing is in flight. */
export class DirectoryListingCache {
  private listings = new Map<string, Promise<TransferDirectory>>();
  private key(endpoint: WorkspaceRef) { return JSON.stringify(endpoint); }
  seed(directory: TransferDirectory) { this.listings.set(this.key(directory.endpoint), Promise.resolve(directory)); }
  clear() { this.listings.clear(); }
  list(endpoint: WorkspaceRef, fresh = false): Promise<TransferDirectory> {
    const key = this.key(endpoint);
    const cached = this.listings.get(key);
    if (cached && !fresh) return cached;
    const request = transferApi.list(endpoint).catch((error) => {
      if (this.listings.get(key) === request) this.listings.delete(key);
      throw error;
    });
    if (this.listings.size >= 64) this.listings.delete(this.listings.keys().next().value!);
    this.listings.set(key, request);
    return request;
  }
}
