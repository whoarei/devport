import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, type DeviceProfile, type WorkspaceRef } from "../api";
import { useAppStore, workspaceLabel } from "../store";
import { useTransferStore } from "../transferStore";
import { appendEndpoint, endpointPath, sameTransferFilename, transferActive, transferApi, transferBytes, type ConflictPolicy, type TransferEntry, type TransferPlan } from "../transferApi";
import { deviceFileBlocker, deviceFileContext } from "../transferFileActions";
import { workspaceSourceRevision } from "../workspaceRun";
import { uploadBusy } from "../editorDocument";
import type { PanelComponentProps } from "../panels/components";
import { PanelTitle } from "./PanelTitle";
import { TransferQueue } from "./TransferQueue";
import { ContextMenu, contextMenuPosition, type MenuEntry, type MenuState } from "./ContextMenu";
import { TransferFileDialog, type TransferFileRequest } from "./TransferFileDialog";
import { DirectoryPathInput } from "./DirectoryPathInput";
import "../fileTransfer.css";
import { FileIcon, Icon } from "./Icon";
import { EmptyState } from "./EmptyState";

function parentEndpoint(endpoint: WorkspaceRef): WorkspaceRef {
  const path = endpointPath(endpoint).replace(/[\\/]$/, "");
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  let parent = index <= 0 ? "/" : path.slice(0, index);
  if (/^[a-z]:$/i.test(parent)) parent += "\\";
  return endpoint.type === "local" ? { type: "local", dir: parent } : { ...endpoint, path: parent };
}

function Browser({ side, hidden, exclude }: { side: "local" | "device"; hidden: boolean; exclude: boolean }) {
  const { t } = useTranslation();
  const browser = useTransferStore((s) => s[side]);
  const target = useTransferStore((s) => s[side === "local" ? "device" : "local"]);
  const planning = useTransferStore((s) => s.planning);
  const plan = useTransferStore((s) => s.plan);
  const deviceMutating = useTransferStore((s) => s.deviceMutating);
  const deviceTransferring = useTransferStore((s) => s.registeredIds.some((id) => !s.tasks.some((task) => task.id === id))
    || s.tasks.some((task) => transferActive(task.state)
      && [task.source, task.target].some((endpoint) => endpoint.type === "device" && browser.endpoint?.type === "device" && endpoint.device_id === browser.endpoint.device_id)));
  const devices = useAppStore((s) => s.devices);
  const appBusy = useAppStore((s) => s.updating || s.saving || s.starting || s.guarding || s.workspaceMutating || uploadBusy(s));
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [fileRequest, setFileRequest] = useState<TransferFileRequest | null>(null);
  const hosts = devices.filter((d) => ["ssh", "wsl"].includes(d.transport));
  const [path, setPath] = useState(browser.endpoint ? endpointPath(browser.endpoint) : "");
  const [deviceId, setDeviceId] = useState(browser.endpoint?.type === "device" ? browser.endpoint.device_id : "");
  const deviceLabel = (device: DeviceProfile) => `${device.name} · ${device.transport.toUpperCase()}${device.transport === "ssh" ? ` · ${device.host}` : ""}`;
  const selectedDevice = hosts.find((device) => device.id === deviceId);
  const [page, setPage] = useState(0);
  useEffect(() => {
    setPath(browser.endpoint ? endpointPath(browser.endpoint) : "");
    setDeviceId(browser.endpoint?.type === "device" ? browser.endpoint.device_id : "");
    setPage(0);
  }, [browser.endpoint]);
  const sourceRevision = workspaceSourceRevision(browser.endpoint, devices);
  useEffect(() => {
    setMenu(null);
    if (!useTransferStore.getState().deviceMutating) setFileRequest(null);
  }, [browser.generation, sourceRevision]);
  const browse = (endpoint: WorkspaceRef) => void useTransferStore.getState().browse(side, endpoint);
  const submit = (value = path) => {
    if (browser.loading || !value.trim() || (side === "device" && !deviceId)) return;
    browse(side === "local" ? { type: "local", dir: value } : { type: "device", device_id: deviceId, path: value });
  };
  const chooseFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, multiple: false, title: t("transfer.chooseFolder") });
      if (typeof dir === "string") browse({ type: "local", dir });
    } catch (error) { useTransferStore.setState({ error: errorMessage(error) }); }
  };
  const entries = browser.directory?.entries.filter((e) => hidden || !e.name.startsWith(".")) ?? [];
  const selectable = entries.filter((e) => ["file", "dir"].includes(e.kind));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(entries.length / 100) - 1));
  const unavailable = planning || !!plan || deviceMutating || browser.loading || target.loading || !browser.directory || !target.directory;
  const fileBlocker = deviceFileBlocker(side === "device" ? deviceFileContext() : null);
  const fileUnavailable = !!fileBlocker || appBusy || deviceMutating || deviceTransferring;
  const selectedEntry = browser.selected.length === 1 ? selectable.find((e) => e.name === browser.selected[0]) : undefined;
  const requestFileAction = (type: TransferFileRequest["type"], entry?: TransferEntry) => {
    const context = deviceFileContext();
    if (!context) return;
    const blocked = deviceFileBlocker(context);
    if (blocked) { useTransferStore.setState({ error: blocked }); return; }
    setFileRequest({ context, type, name: entry?.name, directory: entry?.kind === "dir" });
  };
  const openFileMenu = (event: MouseEvent, entry?: TransferEntry) => {
    if (side !== "device") return;
    event.preventDefault(); event.stopPropagation();
    const context = deviceFileContext();
    if (!context) return;
    const disabled = !!deviceFileBlocker(context);
    const open = (type: TransferFileRequest["type"]) => {
      if (deviceFileBlocker(context)) return;
      setFileRequest({ context, type, name: entry?.name, directory: entry?.kind === "dir" });
    };
    const entries: MenuEntry[] = entry ? [
      { label: t("workspace.rename"), disabled: disabled || !["file", "dir"].includes(entry.kind), onSelect: () => open("rename") },
      { label: t("workspace.delete"), danger: true, disabled: disabled || !["file", "dir"].includes(entry.kind), onSelect: () => open("delete") },
    ] : [
      { label: t("workspace.newFile"), disabled, onSelect: () => open("create-file") },
      { label: t("workspace.newDir"), disabled, onSelect: () => open("create-dir") },
    ];
    setMenu({ ...contextMenuPosition(event.clientX, event.clientY, entries.length), entries });
  };
  const targetLabel = target.directory ? workspaceLabel(target.directory.endpoint, devices) : "";
  const actionTitle = (name: string) => targetLabel ? t(side === "local" ? "transfer.uploadTo" : "transfer.downloadTo", { name, path: targetLabel }) : t("transfer.chooseTarget");
  return <div className="transfer-browser">
    <div className="transfer-browser-heading"><span className="transfer-browser-title">
      <Icon name={side === "local" ? "monitor" : "server"} />
      <strong>{t(`transfer.${side}`)}</strong></span>
      {side === "device" &&
        <select aria-label={t("transfer.selectDevice")} title={selectedDevice ? deviceLabel(selectedDevice) : t("transfer.selectDevice")} value={deviceId} onChange={(event) => {
          const id = event.target.value; setDeviceId(id);
          void useTransferStore.getState().openDevice(id);
        }} disabled={deviceMutating}><option value="">{t("transfer.selectDevice")}</option>{hosts.map((d) => <option key={d.id} value={d.id}>{deviceLabel(d)}</option>)}</select>}
    </div>
    <form className="transfer-path" onSubmit={(event) => { event.preventDefault(); if (!deviceMutating) submit(); }}>
      <button type="button" aria-label={t("transfer.up")} title={t("transfer.up")} disabled={!browser.directory || browser.loading || deviceMutating} onClick={() => browser.endpoint && browse(parentEndpoint(browser.endpoint))}><Icon name="arrowUp" /></button>
      {side === "device" && <button type="button" aria-label={t("transfer.resetDeviceRoot")} title={t("transfer.resetDeviceRoot")}
        disabled={!selectedDevice?.workspace_root.trim() || browser.loading || deviceMutating} onClick={() => void useTransferStore.getState().resetDeviceRoot(deviceId)}><Icon name="folder" /></button>}
      <div className="transfer-address"><DirectoryPathInput label={t("transfer.path")} placeholder={side === "local" ? t("transfer.localPath") : "/home"}
        value={path} onChange={setPath} onNavigate={(value) => { if (!deviceMutating) submit(value); }}
        endpoint={side === "local" ? { type: "local", dir: path } : deviceId ? { type: "device", device_id: deviceId, path } : null}
        contextKey={JSON.stringify([side, deviceId, sourceRevision])} directory={browser.directory} disabled={browser.loading || deviceMutating} />
        {side === "local" && <button type="button" aria-label={t("transfer.chooseFolder")} title={t("transfer.chooseFolder")} disabled={browser.loading} onClick={() => void chooseFolder()}>
          <Icon name="folderOpen" />
        </button>}
        <button type="submit" aria-label={t("transfer.go")} title={t("transfer.go")} disabled={deviceMutating || browser.loading || !path.trim() || (side === "device" && !deviceId)}><Icon name="arrowRight" /></button>
      </div>
      <button type="button" aria-label={t("transfer.refresh")} title={t("transfer.refresh")} disabled={!browser.endpoint || browser.loading || deviceMutating} onClick={() => browser.endpoint && browse(browser.endpoint)}><Icon name="refresh" className={browser.loading ? "icon-spinning" : ""} /></button>
    </form>
    {side === "device" ? <div className="transfer-file-actions" role="toolbar" aria-label={t("transfer.fileManagement")} title={fileBlocker ?? undefined}>
      <button disabled={fileUnavailable} onClick={() => requestFileAction("create-file")}>{t("workspace.newFile")}</button>
      <button disabled={fileUnavailable} onClick={() => requestFileAction("create-dir")}>{t("workspace.newDir")}</button>
      <button disabled={fileUnavailable || !selectedEntry} onClick={() => selectedEntry && requestFileAction("rename", selectedEntry)}>{t("workspace.rename")}</button>
      <button disabled={fileUnavailable || !selectedEntry} onClick={() => selectedEntry && requestFileAction("delete", selectedEntry)}>{t("workspace.delete")}</button>
    </div> : <div className="transfer-file-actions transfer-file-summary"><span>{browser.directory ? t("transfer.entryCount", { count: entries.length }) : t("transfer.local")}</span></div>}
    <div className="transfer-files" aria-busy={browser.loading} onContextMenu={(event) => openFileMenu(event)}>
      {browser.loading && entries.length > 0 && <p role="status" className="transfer-hint">{t("transfer.loading")}</p>}
      {browser.error && <div role="alert" className="transfer-browser-error"><Icon name="alert" /><div><strong>{t("transfer.readFailed")}</strong><p>{browser.error}</p>
        {browser.endpoint && <button disabled={browser.loading || deviceMutating} onClick={() => browser.endpoint && browse(browser.endpoint)}><Icon name="refresh" />{t("workspaceRun.retry")}</button>}
      </div></div>}
      {browser.directory && (!browser.error || entries.length > 0) && <table><thead><tr><th className="transfer-select-column"><input type="checkbox" aria-label={t("transfer.selectAll")} disabled={!selectable.length} checked={selectable.length > 0 && selectable.every((e) => browser.selected.includes(e.name))} onChange={(event) => useTransferStore.getState().select(side, event.target.checked ? selectable.map((e) => e.name) : [])} /></th><th>{t("transfer.name")}</th><th className="transfer-size-column">{t("transfer.size")}</th><th className="transfer-action-column">{t("transfer.action")}</th></tr></thead>
        <tbody>{entries.slice(currentPage * 100, (currentPage + 1) * 100).map((entry) => <tr key={entry.name} className={browser.selected.includes(entry.name) ? "selected" : undefined} onContextMenu={(event) => openFileMenu(event, entry)}>
          <td><input type="checkbox" aria-label={t("transfer.selectEntry", { name: entry.name })} disabled={!["file", "dir"].includes(entry.kind)} checked={browser.selected.includes(entry.name)} onChange={(event) => useTransferStore.getState().select(side, event.target.checked ? [...browser.selected, entry.name] : browser.selected.filter((n) => n !== entry.name))} /></td>
          <td><button className="transfer-file-name" title={entry.name} disabled={deviceMutating || !["file", "dir"].includes(entry.kind)} onClick={() => {
            if (entry.kind === "dir" && browser.endpoint) browse(appendEndpoint(browser.endpoint, entry.name));
            else useTransferStore.getState().select(side, browser.selected.includes(entry.name) ? browser.selected.filter((n) => n !== entry.name) : [...browser.selected, entry.name]);
          }}><FileIcon name={entry.name} directory={entry.kind === "dir"} /><span>{entry.name}</span></button>
            {!["file", "dir"].includes(entry.kind) && <small>{t("transfer.unsupported")}</small>}</td>
          <td className="transfer-file-size">{entry.kind === "file" ? transferBytes(entry.size) : "—"}</td>
          <td><button className="transfer-entry-action" disabled={unavailable || !["file", "dir"].includes(entry.kind)} title={actionTitle(entry.name)} aria-label={actionTitle(entry.name)} onClick={() => void useTransferStore.getState().prepare(side, exclude, [entry.name])}>{side === "local" ? <>{t("transfer.upload")} <span aria-hidden="true">→</span></> : <><span aria-hidden="true">←</span> {t("transfer.download")}</>}</button></td>
        </tr>)}</tbody></table>}
      {entries.length === 0 && !browser.error && <div role={browser.loading ? "status" : undefined}>
        <EmptyState compact icon={browser.loading ? "refresh" : "folderOpen"}
          title={t(browser.loading ? "transfer.loading" : browser.directory ? "transfer.emptyDirectory" : side === "device" && !deviceId ? "transfer.selectDevice" : "transfer.chooseDirectory")}
          description={!browser.loading && !browser.directory ? t(side === "device" && !deviceId ? "transfer.chooseDeviceHint" : "transfer.chooseDirectoryHint") : undefined}>
          {!browser.loading && !browser.directory && side === "local" && <button onClick={() => void chooseFolder()}><Icon name="folderOpen" />{t("transfer.chooseFolder")}</button>}
        </EmptyState>
      </div>}
    </div>
    {entries.length > 100 && <div className="transfer-file-pages"><button aria-label={t("transfer.previousPage")} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>←</button> {currentPage + 1} / {Math.ceil(entries.length / 100)} <button aria-label={t("transfer.nextPage")} disabled={(currentPage + 1) * 100 >= entries.length} onClick={() => setPage(currentPage + 1)}>→</button></div>}
    {browser.selected.length > 0 && <div className="transfer-selection-actions">
      <button className="transfer-batch-action" disabled={unavailable} title={actionTitle(browser.selected.join(", "))} onClick={() => void useTransferStore.getState().prepare(side, exclude)}>{t(side === "local" ? "transfer.uploadSelected" : "transfer.downloadSelected", { count: browser.selected.length })}</button>
    </div>}
    {side === "device" && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    {fileRequest && <TransferFileDialog request={fileRequest} onClose={() => setFileRequest(null)} />}
  </div>;
}

function PlanDialog({ plan }: { plan: TransferPlan }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  const [policy, setPolicy] = useState<ConflictPolicy>(plan.keep_both ? "keep_both" : "skip");
  const [preserve, setPreserve] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const devices = useAppStore((s) => s.devices);
  useEffect(() => { const dialog = ref.current; if (dialog && !dialog.open) dialog.showModal(); }, []);
  const start = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const id = await transferApi.start(plan.id, policy, preserve);
      useTransferStore.getState().register(id);
      useTransferStore.setState({ plan: null });
      await useTransferStore.getState().refresh();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const overwriteProtected = plan.items.some((i) => plan.request.protected_paths.some((path) => sameTransferFilename(path, i.path, plan.request.target)));
  return <dialog ref={ref} className="transfer-plan-dialog" aria-labelledby="transfer-plan-title" onCancel={(event) => { event.preventDefault(); if (!busy) useTransferStore.getState().discard(); }}>
    <h2 id="transfer-plan-title">{t("transfer.review")}</h2>
    <p className="transfer-endpoint">{workspaceLabel(plan.request.source, devices)}<br />→ {workspaceLabel(plan.request.target, devices)}</p>
    <p>{t("transfer.planSummary", { count: plan.items.length, bytes: transferBytes(plan.total_bytes), conflicts: plan.conflicts })}</p>
    <label>{t("transfer.conflictPolicy")}<select value={policy} disabled={busy} onChange={(e) => setPolicy(e.target.value as ConflictPolicy)}>
      <option value="keep_both" disabled={!plan.keep_both}>{t("transfer.keepBoth")}</option><option value="skip">{t("transfer.skip")}</option>
      <option value="overwrite" disabled={!plan.overwrite || overwriteProtected}>{t("transfer.overwrite")}</option>
    </select></label>
    {!plan.overwrite && <p className="transfer-hint">{t("transfer.noOverwrite")}</p>}
    {!plan.keep_both && <p className="transfer-hint">{t("transfer.noKeepBoth")}</p>}
    {overwriteProtected && <p className="transfer-hint">{t("transfer.protectedFiles")}</p>}
    <label className="transfer-checkbox"><input type="checkbox" checked={preserve} onChange={(e) => setPreserve(e.target.checked)} />{t("transfer.preserveExecutable")}</label>
    <p className="transfer-hint">{t("transfer.copyHint")}</p>
    {plan.warnings.length > 0 && <details><summary>{t("transfer.warnings", { count: plan.warnings.length })}</summary><ul>{plan.warnings.slice(0, 100).map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
    {error && <p role="alert" className="transfer-error">{error}</p>}
    <div className="transfer-dialog-actions"><button disabled={busy} onClick={() => useTransferStore.getState().discard()}>{t("transfer.cancel")}</button><button disabled={busy} onClick={() => void start()}>{t("transfer.start")}</button></div>
  </dialog>;
}

export function FileTransferPanel({ visible, collapsed, onToggleCollapse }: PanelComponentProps) {
  const { t } = useTranslation();
  const planning = useTransferStore((s) => s.planning);
  const plan = useTransferStore((s) => s.plan);
  const error = useTransferStore((s) => s.error);
  const devices = useAppStore((s) => s.devices);
  const workspace = useAppStore((s) => s.workspace);
  const selectedDeviceId = useAppStore((s) => s.selectedDeviceId);
  const environmentReady = useAppStore((s) => s.environmentReady);
  const { hidden, exclude } = useTransferStore((s) => s.options);
  const setHidden = (hidden: boolean) => useTransferStore.setState((s) => ({ options: { ...s.options, hidden } }));
  const setExclude = (exclude: boolean) => useTransferStore.setState((s) => ({ options: { ...s.options, exclude } }));
  useEffect(() => {
    if (!visible || !environmentReady) return;
    useTransferStore.getState().restore();
  }, [visible, devices, workspace, selectedDeviceId, environmentReady]);
  return <div className="file-transfer-panel">
    <PanelTitle title={t("transfer.title")} collapsed={collapsed} onToggle={onToggleCollapse} className="center-panel-header">
      <button className="transfer-hide" aria-label={t("transfer.hide")} title={t("transfer.hide")} onClick={() => {
        const state = useAppStore.getState();
        state.setLayout({ panelVisible: { ...state.layout.panelVisible, transfer: false } });
      }}><Icon name="close" /></button>
    </PanelTitle>
    {!collapsed && <div className="transfer-content">
      <div className="transfer-toolbar"><label><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> {t("transfer.showHidden")}</label><label><input type="checkbox" checked={exclude} onChange={(e) => setExclude(e.target.checked)} /> {t("transfer.projectFiles")}</label><span>{t("transfer.limits")}</span></div>
      <div className="transfer-browsers"><Browser side="local" hidden={hidden} exclude={exclude} /><Browser side="device" hidden={hidden} exclude={exclude} /></div>
      {planning && <p role="status" className="transfer-hint">{t("transfer.scanning")}</p>}
      {error && <div role="alert" className="transfer-error">{error} <button aria-label={t("transfer.dismiss")} onClick={() => useTransferStore.setState({ error: null })}>×</button></div>}
      <TransferQueue visible={visible} />
    </div>}
    {plan && visible && !collapsed && <PlanDialog key={plan.id} plan={plan} />}
  </div>;
}
