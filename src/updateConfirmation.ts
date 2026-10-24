import { create } from "zustand";
import type { AppUpdateInfo } from "./api";

interface UpdateConfirmation {
  info: AppUpdateInfo;
  terminalCount: number;
  returnFocus: HTMLElement | null;
  respond: (confirmed: boolean) => void;
}

export const useUpdateConfirmationStore = create<{ request: UpdateConfirmation | null }>(() => ({ request: null }));

export function updateFocusTarget(): HTMLElement | null {
  return typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

/** Both update entry points wait for the same application-modal confirmation. */
export function confirmTerminalClose(info: AppUpdateInfo, terminalCount: number, returnFocus: HTMLElement | null = null): Promise<boolean> {
  useUpdateConfirmationStore.getState().request?.respond(false);
  return new Promise((resolve) => {
    const request: UpdateConfirmation = {
      info,
      terminalCount,
      returnFocus,
      respond: (confirmed) => {
        if (useUpdateConfirmationStore.getState().request !== request) return;
        useUpdateConfirmationStore.setState({ request: null });
        resolve(confirmed);
      },
    };
    useUpdateConfirmationStore.setState({ request });
  });
}
