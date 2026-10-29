import { listen } from "@tauri-apps/api/event";
import { api, errorMessage, workspaceRefEquals, type WorkspaceOpenRequest } from "./api";
import { useAppStore } from "./store";
import { openWorkspace } from "./workspacePicker";
import i18n from "./i18n";

const blocked = (state = useAppStore.getState()) =>
  state.loading || state.saving || state.starting || state.guarding || state.workspaceMutating || state.updating;

/** Listen before draining so startup and relaunch requests cannot fall between the two. */
export function listenForWorkspaceLaunches(ready: Promise<unknown>, source = {
  take: api.takeWorkspaceLaunch,
  listen: (notify: () => void) => listen("workspace://open-requested", notify),
}): () => void {
  let disposed = false, started = false, running = false, again = false;
  let pending: WorkspaceOpenRequest | null = null;
  let unlisten: (() => void) | undefined;
  const report = (error: unknown) => useAppStore.setState({ editorError: i18n.t("workspace.openFailed", { message: errorMessage(error) }) });
  const wake = () => { again = true; void drain(); };
  async function drain() {
    if (disposed || !started || running || blocked()) return;
    running = true;
    try {
      do {
        again = false;
        while (!disposed && !blocked()) {
          pending ??= await source.take();
          if (disposed || blocked()) break;
          const request = pending;
          pending = null;
          if (!request) break;
          if (request.type === "error") report(request.message);
          else if (!workspaceRefEquals(useAppStore.getState().workspace, request.workspace)) await openWorkspace(request.workspace);
        }
      } while (again && !disposed && !blocked());
    } catch (error) { report(error); }
    finally { running = false; }
  }
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (blocked(previous) && !blocked(state)) wake();
  });
  // Let recovery finish before switching away, so restored drafts get the usual guard.
  void Promise.all([ready, source.listen(wake)]).then(([, off]) => {
    if (disposed) { off(); return; }
    unlisten = off;
    started = true;
    wake();
  }).catch((error) => { if (!disposed) report(error); });
  return () => { disposed = true; unsubscribe(); unlisten?.(); };
}
