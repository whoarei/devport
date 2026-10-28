const MARKER = "devport.storage-import.v1";

/** Copy before any preference module initializes; existing DevPort values win. */
export function migrateBrowserStorage(storage: Storage): void {
  if (storage.getItem(MARKER) === "complete") return;
  const entries: [string, string][] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith("remote-runner.")) {
      const value = storage.getItem(key);
      if (value !== null) entries.push([`devport.${key.slice("remote-runner.".length)}`, value]);
    }
  }
  for (const [key, value] of entries) {
    if (storage.getItem(key) === null) storage.setItem(key, value);
  }
  storage.setItem(MARKER, "complete");
}
