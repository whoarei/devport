import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { workspaceRefEquals, type WorkspaceRef } from "../api";
import { useAppStore } from "../store";
import { useTransferStore } from "../transferStore";
import { appCommandEnabled, executeAppCommand, scriptCommand } from "../appCommands";
import { workspaceTransferPath } from "../transferApi";
import { workspaceSourceRevision } from "../workspaceRun";
import { preserveContentFocus } from "../focus";
import { Icon } from "./Icon";
import { WorkspaceTransferRow } from "./WorkspaceTransferRow";

/** Device browsing can run only scripts belonging to the current source workspace. */
export function workspaceEntryRunPath(source: WorkspaceRef, path: string, directory: boolean, workspace: WorkspaceRef | null) {
  const relative = !directory && workspace ? workspaceTransferPath(source, path, workspace) : null;
  return scriptCommand(relative) ? relative : null;
}

export function WorkspaceEntryRow({ workspace, path, name, directory, disabled, newDisabled, menuKind, onMore, onNew, onContextMenu, children }: {
  workspace: WorkspaceRef; path: string; name: string; directory: boolean; disabled: boolean; newDisabled?: boolean;
  menuKind?: "more" | "new" | null; onMore: (event: MouseEvent<HTMLButtonElement>) => void;
  onNew?: (event: MouseEvent<HTMLButtonElement>) => void; onContextMenu: (event: MouseEvent) => void; children: ReactNode;
}) {
  const { t } = useTranslation();
  const app = useAppStore(useShallow((s) => ({ workspace: s.workspace, devices: s.devices,
    busy: s.updating || s.loading || s.saving || s.starting || s.guarding || s.workspaceMutating })));
  const transferBusy = useTransferStore((s) => s.planning || !!s.plan || !!s.workspaceTransfer || s.deviceMutating);
  const runPath = workspaceEntryRunPath(workspace, path, directory, app.workspace);
  const revision = workspaceSourceRevision(workspace, app.devices);
  const current = () => revision === workspaceSourceRevision(workspace, useAppStore.getState().devices);
  const context = { area: "workspace" as const, filePath: runPath ?? undefined };
  const count = 2 + Number(directory || runPath !== null);
  const action = t(workspace.type === "local" ? "transfer.upload" : "transfer.download");
  const actions = <span className="workspace-entry-actions" role="group" aria-label={t("workspace.entryActions", { name })}
      onMouseDown={preserveContentFocus} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      {directory && onNew && <button type="button" title={t("workspace.newEntry")} aria-label={t("workspace.newEntryIn", { name })}
        aria-haspopup="menu" aria-expanded={menuKind === "new"} disabled={disabled || app.busy || newDisabled} onClick={onNew}><Icon name="plus" /></button>}
      {runPath !== null && <button type="button" title={t("run.run")} aria-label={t("workspace.runEntry", { name })}
        disabled={disabled || !appCommandEnabled("runFile", context)} onClick={() => {
          if (current() && workspaceRefEquals(app.workspace, useAppStore.getState().workspace)) void executeAppCommand("runFile", context);
        }}><Icon name="play" /></button>}
      <button type="button" title={action} aria-label={t("workspace.transferEntry", { action, name })} disabled={disabled || app.busy || transferBusy}
        onClick={() => { if (current()) useTransferStore.getState().requestWorkspaceTransfer(workspace, path, directory); }}><Icon name="arrowUp" className={workspace.type === "device" ? "entry-download-icon" : ""} /></button>
      <button type="button" title={t("workspace.moreActionsLabel")} aria-label={t("workspace.moreActions", { name })}
        aria-haspopup="menu" aria-expanded={menuKind === "more"} disabled={disabled} onClick={onMore}><Icon name="more" /></button>
    </span>;
  return <div className={`workspace-entry-row${menuKind ? " entry-menu-open" : ""}`} onContextMenu={onContextMenu}
    style={{ "--entry-actions-width": `${count * 24 + 8}px` } as CSSProperties}>
    <WorkspaceTransferRow workspace={workspace} path={path} actions={actions}>{children}</WorkspaceTransferRow>
  </div>;
}
