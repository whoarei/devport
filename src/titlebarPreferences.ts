import { create } from "zustand";
import type { WorkspacePathDisplay } from "./workspacePresentation";

const STORAGE_KEY = "devport.titlebar-path-display.v1";

export function loadTitlebarPathDisplay(): WorkspacePathDisplay {
  try { return localStorage.getItem(STORAGE_KEY) === "full" ? "full" : "short"; }
  catch { return "short"; }
}

export const useTitlebarPreferences = create<{
  pathDisplay: WorkspacePathDisplay;
  setPathDisplay: (pathDisplay: WorkspacePathDisplay) => void;
}>((set) => ({
  pathDisplay: loadTitlebarPathDisplay(),
  setPathDisplay: (pathDisplay) => {
    try { localStorage.setItem(STORAGE_KEY, pathDisplay); }
    catch { /* Keep the session preference when storage is unavailable. */ }
    set({ pathDisplay });
  },
}));
