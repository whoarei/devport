import { useEffect, useMemo, useRef, useState, type KeyboardEventHandler, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, errorMessage, type LocalShellInfo, type PythonProbe } from "../api";
import { useAppStore, workspaceLabel } from "../store";
import { useWorkspaceRunStore, workspaceSourceCurrent, preparationActive } from "../workspaceRunStore";
import { commandLabel, commandsFor, validModule, workspaceKey, workspaceSourceRevision } from "../workspaceRun";
import { ConfirmDialog, type ConfirmRequest } from "./ConfirmDialog";
import { missingCommandIds } from "../workspaceRunMenu";
import { runPhaseLabel, runStateLabel } from "../runState";
import type { OutputBuffer } from "../outputBuffer";
import { handleRunShortcut, parseRunArguments } from "../runArguments";
import { ArgumentsEditor } from "./ArgumentsEditor";
import { editorPathInWorkspace } from "../editorSources";
import { Icon } from "./Icon";

function Modal({ open, title, close, children, onKeyDown, className, heading }: {
  open: boolean; title: string; close: () => void; children: ReactNode;
  onKeyDown?: KeyboardEventHandler<HTMLDialogElement>; className?: string; heading?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current; if (open && d && !d.open) d.showModal(); if (!open && d?.open) d.close(); }, [open]);
  return <dialog className={className ? `runner-dialog ${className}` : "runner-dialog"} ref={ref} aria-label={title}
    onKeyDown={onKeyDown} onCancel={(e) => { e.preventDefault(); close(); }}>
    {heading ?? <h3>{title}</h3>}{children}
  </dialog>;
}

function ArgsDialog() {
  const { t } = useTranslation(), state = useWorkspaceRunStore(), draft = state.args;
  const { devices, selectedDeviceId } = useAppStore();
  const [argsText, setArgsText] = useState(""), [name, setName] = useState(""), [error, setError] = useState<string | null>(null);
  useEffect(() => { setArgsText(draft?.command.args.join("\n") ?? ""); setName(draft ? draft.command.entry.type === "python_module" ? draft.command.entry.name : draft.command.entry.path : ""); setError(null); }, [draft]);
  const close = () => useWorkspaceRunStore.setState({ args: null });
  const entry = draft?.module ? { type: "python_module" as const, name } : draft?.editingId && draft.command.entry.type !== "python_module" ? { ...draft.command.entry, path: name } : draft?.command.entry;
  const args = draft?.editingId ? draft.command.args : parseRunArguments(argsText);
  const canSubmit = !!entry && (!draft?.module || validModule(name));
  const submit = () => {
    if (!draft || !entry || !canSubmit) return;
    if (draft.editingId && state.commands) void api.editWorkspaceCommandEntry(draft.workspace, draft.editingId, entry, state.commands.revision).then((commands) => { if (workspaceSourceCurrent(draft.workspace, state.sourceRevision)) { useWorkspaceRunStore.setState({ commands }); if (useWorkspaceRunStore.getState().args === draft) close(); } }).catch((e) => { if (workspaceSourceCurrent(draft.workspace, state.sourceRevision)) { setError(errorMessage(e)); void state.refreshCommands(); } });
    else if (workspaceSourceCurrent(draft.workspace, state.sourceRevision)) { state.run({ entry, args }, draft.source, draft.workspace); close(); }
  };
  return <Modal open={!!draft} title={t("workspaceRun.withArgs")} close={close} onKeyDown={e => { if (!draft?.editingId) handleRunShortcut(e, submit); }}>
    {draft && <>
    <div className="secondary-text">{workspaceLabel(draft?.workspace ?? null, devices)} · {devices.find((d) => d.id === selectedDeviceId)?.name} · {selectedDeviceId && state.preferences.python[selectedDeviceId] === "project" ? t("workspaceRun.project") : t("workspaceRun.system")}</div>
    {draft?.module || draft?.editingId ? <label>{t(draft.module ? "workspaceRun.moduleName" : "runnerEntry.entryPath")}<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label> : <code>{draft ? commandLabel(draft.command) : ""}</code>}
    <ArgumentsEditor value={argsText} onChange={setArgsText} disabled={!!draft.editingId} autoFocus={!draft.module && !draft.editingId}
      preview={[...(entry?.type === "python_module" ? ["-m", name] : [entry?.path ?? ""]), ...args]} />
    {error && <div className="runtime-error">{error}</div>}
    <div className="dialog-actions"><button onClick={close}>{t("dialog.cancel")}</button><button className="primary" disabled={!canSubmit} onClick={submit} title={draft.editingId ? undefined : t("workspaceRun.runShortcut")}>{t(draft.editingId ? "workspaceRun.save" : "run.run")}</button></div>
    </>}
  </Modal>;
}

function preparationLog(buffer?: OutputBuffer): string {
  let remaining = 64 * 1024;
  const chunks: Uint8Array[] = [];
  for (let i = (buffer?.chunks.length ?? 0) - 1; i >= 0 && remaining > 0; i--) {
    const chunk = buffer!.chunks[i], tail = chunk.subarray(Math.max(0, chunk.length - remaining));
    chunks.unshift(tail); remaining -= tail.length;
  }
  const decoder = new TextDecoder();
  return (chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode())
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").replace(/\r\n?/g, "\n");
}

function PreparationStatus() {
  const { t } = useTranslation();
  const p = useWorkspaceRunStore((s) => s.preparation), cancel = useWorkspaceRunStore((s) => s.cancelPreparation);
  const devices = useAppStore((s) => s.devices);
  const buffer = useAppStore((s) => p?.runId ? s.outputBuffers[p.runId] : undefined);
  const progress = useAppStore((s) => p?.runId ? s.runProgress[p.runId] : undefined);
  const text = useMemo(() => preparationLog(buffer), [buffer]);
  const log = useRef<HTMLPreElement>(null), follow = useRef(true);
  useEffect(() => { follow.current = true; }, [p?.token]);
  useEffect(() => { if (log.current && follow.current) log.current.scrollTop = log.current.scrollHeight; }, [text]);
  if (!p) return null;
  const active = preparationActive(p), status = p.status, error = p.error ?? status?.error;
  const ready = status?.state === "exited" && status.exit_code === 0;
  return <section className="runner-preparation" aria-label={t("workspaceRun.preparationStatus")}>
    <strong>{t(p.rebuild ? "runtime.rebuild" : "workspaceRun.prepare")}</strong>
    <div className="runner-location">{workspaceLabel(p.workspace, devices)} · {p.deviceName}</div>
    <div role="status" className={`run-state state-${error ? "failed" : status?.state ?? "preparing"}`}>
      {ready ? t("workspaceRun.preparationReady") : status?.waiting_workspace ? t("workspaceSync.waiting") : status ? runStateLabel(status.state) : error ? runStateLabel("failed") : t("workspaceRun.preparationSubmitting")}
      {(active || status?.state === "failed") && status?.phase && ` · ${runPhaseLabel(status.phase)}`}
    </div>
    {active && <progress aria-label={t("workspaceRun.preparationStatus")} />}
    {active && progress && <div className="runner-preparation-progress">{progress}</div>}
    {error && <div className="runtime-error" role="alert">{error}</div>}
    {text && <details className="runner-preparation-details" onToggle={(event) => {
      if (event.currentTarget.open && follow.current && log.current) log.current.scrollTop = log.current.scrollHeight;
    }}><summary>{t("workspaceRun.preparationLog")}</summary><pre ref={log} onScroll={() => { const el = log.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>{text}</pre></details>}
    {active && <div className="runner-inline-actions"><button className="danger" disabled={!p.runId || p.stopping || status?.state === "stopping"} onClick={() => void cancel()}>{t(p.stopping || status?.state === "stopping" ? "workspaceRun.preparationStopping" : "workspaceRun.cancelPreparation")}</button><span className="secondary-text">{t("workspaceRun.preparationBackground")}</span></div>}
  </section>;
}

function SettingsDialog() {
  const { t } = useTranslation(), state = useWorkspaceRunStore();
  const { workspace, devices, selectedDeviceId } = useAppStore();
  const device = devices.find((d) => d.id === selectedDeviceId), key = workspaceKey(workspace);
  const sourceRevision = workspaceSourceRevision(workspace, devices);
  const preparing = preparationActive(state.preparation);
  const python = selectedDeviceId ? state.preferences.python[selectedDeviceId] ?? "device_default" : "device_default";
  const serial = device?.transport === "serial";
  const project = state.info?.project;
  const location = workspaceLabel(workspace, devices);
  const title = t("runSettings.title");
  const [cwd, setCwd] = useState("."), [env, setEnv] = useState("{}"), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [shells, setShells] = useState<LocalShellInfo[]>([]), [probe, setProbe] = useState<PythonProbe | null>(null), [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const probeEpoch = useRef(0);
  const loadedCwd = useRef(".");
  const advanced = useRef<HTMLDetailsElement>(null);
  const notices = useRef<HTMLDivElement>(null);
  const messages = [...new Set([error ?? state.configError, state.infoError, state.launchError])].filter(Boolean);
  useEffect(() => { setBusy(false); }, [key, sourceRevision]);
  useEffect(() => { setConfirm(null); if (state.settingsOpen) { loadedCwd.current = state.config?.config.run_defaults.cwd ?? "."; setCwd(loadedCwd.current); setEnv(JSON.stringify(state.preferences.env, null, 2)); setError(null); void api.listLocalShells().then(setShells).catch(() => {}); } }, [state.settingsOpen, key, sourceRevision]);
  useEffect(() => { const next = state.config?.config.run_defaults.cwd ?? ".", previous = loadedCwd.current; setCwd((draft) => draft === previous ? next : draft); loadedCwd.current = next; }, [state.config]);
  useEffect(() => { ++probeEpoch.current; setProbe(null); }, [selectedDeviceId, device?.revision, key, sourceRevision, state.settingsOpen]);
  useEffect(() => { if (error && state.settingsOpen) notices.current?.scrollIntoView({ block: "nearest" }); }, [error]);
  const close = () => useWorkspaceRunStore.setState({ settingsOpen: false });
  const parseEnv = () => {
    let value: unknown;
    try { value = JSON.parse(env); } catch { /* Show the same message for malformed JSON. */ }
    if (value && !Array.isArray(value) && typeof value === "object" && Object.values(value).every((v) => typeof v === "string")) {
      return value as Record<string, string>;
    }
    if (advanced.current) advanced.current.open = true;
    throw new Error(t("workspaceRun.envInvalid"));
  };
  const save = async (session = false) => {
    if (!workspace) return;
    setBusy(true); setError(null);
    try {
      const env = parseEnv(), config = { schema: 1 as const, run_defaults: { cwd } };
      const saved = session ? { config, revision: "session" } : await api.saveRunnerConfig(workspace, config, state.config?.revision ?? "missing");
      if (!workspaceSourceCurrent(workspace, state.sourceRevision)) return;
      useWorkspaceRunStore.setState({ config: saved, configError: null }); state.preference({ env }); close();
    } catch (e) { if (workspaceSourceCurrent(workspace, state.sourceRevision)) setError(errorMessage(e)); } finally { if (workspaceSourceCurrent(workspace, state.sourceRevision)) setBusy(false); }
  };
  const check = async () => {
    const token = ++probeEpoch.current;
    setError(null);
    await state.refreshConfig();
    if (token !== probeEpoch.current) return;
    await state.check();
    if (token !== probeEpoch.current || !selectedDeviceId || state.preferences.python[selectedDeviceId] === "project") return;
    setProbe(null);
    try { const result = await api.probePythonEnvironment(selectedDeviceId); if (token === probeEpoch.current) setProbe(result); } catch (e) { if (token === probeEpoch.current) setError(errorMessage(e)); }
  };
  const recoverLock = async () => {
    if (!workspace) return;
    try {
      const lock = await api.runnerLockInfo(workspace);
      if (!workspaceSourceCurrent(workspace, state.sourceRevision)) return;
      if (!lock) { setError(t("workspaceRun.noLock")); return; }
      setConfirm({ title: t("workspaceRun.recoverLock"), message: `${t("workspaceRun.lockMessage")}\n${JSON.stringify(lock.content)}`, confirmLabel: t("workspaceRun.recoverLock"), danger: true, onCancel: () => setConfirm(null), onConfirm: () => { setConfirm(null); if (workspaceSourceCurrent(workspace, state.sourceRevision)) void api.recoverRunnerLock(workspace, lock.revision).then(() => { if (workspaceSourceCurrent(workspace, state.sourceRevision)) void state.load(); }).catch((e) => { if (workspaceSourceCurrent(workspace, state.sourceRevision)) setError(errorMessage(e)); }); } });
    } catch (e) { if (workspaceSourceCurrent(workspace, state.sourceRevision)) setError(errorMessage(e)); }
  };
  const openLegacyEntry = () => {
    const name = state.info?.legacy_entry;
    if (!name || !workspace || !workspaceSourceCurrent(workspace, sourceRevision)) return;
    const module = state.info?.legacy_module ?? false;
    const entry = module ? { type: "python_module" as const, name } : { type: "python_script" as const, path: name };
    useWorkspaceRunStore.setState({ settingsOpen: false, args: { workspace, command: { entry, args: [] }, module } });
  };

  return <><Modal open={state.settingsOpen} title={title} close={close} className="run-settings-dialog"
    heading={<header className="run-settings-header">
      <h2>{title}</h2>
      {location && <p title={location}>{location}</p>}
    </header>}>
    <div className="run-settings-body" key={`${state.settingsOpen}:${key}:${sourceRevision}`}>
      <div className="run-settings-fields">
        <label>{t("workspaceRun.target")}
          <select title={device?.name} value={selectedDeviceId ?? ""} onChange={(e) => state.selectTarget(e.target.value || null)}>
            <option value="">{t("run.selectDeviceFirst")}</option>
            {devices.map((d) => <option value={d.id} key={d.id}>{d.name}</option>)}
          </select>
        </label>
        <label>{t("workspaceRun.python")}
          <select value={python} onChange={(e) => state.selectPython(e.target.value as typeof python)}>
            <option value="device_default">{t("workspaceRun.system")}</option>
            <option value="project" disabled={serial}>{t("workspaceRun.project")}</option>
          </select>
        </label>
        <label className="run-settings-directory">{t("workspaceRun.cwd")}
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="." />
        </label>
        <label>{t("run.consoleModeLabel")}
          <select disabled={serial} value={serial ? "pty" : state.preferences.console_mode}
            onChange={(e) => state.preference({ console_mode: e.target.value as "pty" | "pipe" })}>
            <option value="pty">PTY</option><option value="pipe">pipe</option>
          </select>
        </label>
        <label>{t("runHistory.timeout")}
          <input type="number" min="0" title={t("runSettings.timeoutHint")} aria-description={t("runSettings.timeoutHint")}
            value={state.preferences.timeout_secs} onChange={(e) => state.preference({ timeout_secs: Number(e.target.value) || 0 })} />
        </label>
      </div>
      <PreparationStatus />
      <details className="run-settings-section">
        <summary><Icon name="chevronRight" /><span>{t("runSettings.pythonDetails")}</span>
          {state.checking ? <span className="run-settings-summary-value" role="status">{t("workspaceRun.loading")}</span>
            : state.info?.python_version && <span className="run-settings-summary-value run-settings-version">Python {state.info.python_version}</span>}
        </summary>
        <div className="run-settings-section-body">
          {(state.info?.python_version || !!state.info?.python_path.length || project) && <dl className="run-settings-meta">
            {state.info?.python_version && <><dt>{t("workspaceRun.version")}</dt><dd>{state.info.python_version}</dd></>}
            {!!state.info?.python_path.length && <><dt>{t("workspaceRun.pythonPath")}</dt><dd><code>{state.info.python_path.join(", ")}</code></dd></>}
            {project && <><dt>uv.lock</dt><dd><code>{project.lock_sha256.slice(0, 12)}</code> · {t(state.cached ? "runnerEntry.cached" : "runnerEntry.notPrepared")}</dd></>}
          </dl>}
          {probe && <code>{probe.program} · Python {probe.version}</code>}
          {state.info?.legacy_entry && workspace && <div>
            <p>{t("workspaceRun.legacyEntry", { entry: state.info.legacy_entry })}</p>
            <button type="button" onClick={openLegacyEntry}>{t("runnerEntry.useLegacy")}</button>
          </div>}
          <div className="run-settings-file-links">
            {[".python-version", "pyproject.toml", "uv.lock"].map((file) => <button type="button" key={file}
              onClick={() => { close(); void useAppStore.getState().openWorkspaceFile(file); }}><code>{file}</code></button>)}
          </div>
          <div className="run-settings-actions">
            <button type="button" disabled={state.checking} onClick={() => void check()}>{t("workspaceRun.recheck")}</button>
            {project && !serial && <>
              <button type="button" disabled={preparing || !selectedDeviceId} onClick={() => void state.prepare()}>{t("workspaceRun.prepare")}</button>
              <button type="button" disabled={preparing || !selectedDeviceId} onClick={() => void state.prepare(true)}>{t("runtime.rebuild")}</button>
            </>}
          </div>
        </div>
      </details>
      <details className="run-settings-section" ref={advanced}>
        <summary><Icon name="chevronRight" /><span>{t("device.advancedOptions")}</span></summary>
        <div className="run-settings-section-body">
          {device?.transport === "local" && <label>{t("workspaceRun.bash")}
            <select value={state.preferences.bash[device.id] ?? ""} onChange={(e) => state.preference({ bash: { ...state.preferences.bash, [device.id]: e.target.value } })}>
              <option value="">{t("workspaceRun.autoBash")}</option>
              {shells.filter((s) => ["bash", "gitbash", "msys2"].includes(s.id)).map((s) => <option key={s.id} value={s.id}>{s.label} · {s.path}</option>)}
            </select>
          </label>}
          <label>{t("workspaceRun.environment")}<textarea rows={3} value={env} onChange={(e) => setEnv(e.target.value)} spellCheck={false} /></label>
          <div className="run-settings-actions"><button type="button" onClick={() => void recoverLock()}>{t("workspaceRun.recoverLock")}</button></div>
        </div>
      </details>
      {messages.length > 0 && <div className="run-settings-notices" ref={notices}>
        {messages.map((message) => <div key={message} className="runtime-error" role="alert">{message}</div>)}
      </div>}
    </div>
    <footer className="dialog-actions run-settings-footer">
      {(error || state.configError) && <button className="run-settings-session" type="button" disabled={busy} onClick={() => void save(true)}>{t("workspaceRun.sessionOnly")}</button>}
      <button type="button" onClick={close}>{t(preparing ? "workspaceRun.close" : "dialog.cancel")}</button>
      <button type="button" className="primary" disabled={busy || !workspace} onClick={() => void save()}>{t("workspaceRun.save")}</button>
    </footer>
  </Modal><ConfirmDialog request={confirm} /></>;
}

function HistoryDialog() {
  const { t } = useTranslation(), state = useWorkspaceRunStore(), history = state.history;
  const [error, setError] = useState<string | null>(null), [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [missing,setMissing]=useState<Set<string>>(new Set());
  useEffect(()=>{let current=true;setMissing(new Set());if(history&&state.commands) void missingCommandIds(history.workspace,state.commands.entries).then((ids)=>{if(current)setMissing(ids);});return ()=>{current=false;};},[history,state.commands]);
  useEffect(() => { setConfirm(null); setError(null); if (history) void state.refreshCommands(); }, [history, state.sourceRevision]);
  const close = () => useWorkspaceRunStore.setState({ history: null });
  return <><Modal open={!!history} title={t("workspaceRun.history")} close={close}>
    <p>{t("workspaceRun.globalDelete")}</p>{(error || state.historyError) && <div className="runtime-error">{error ?? state.historyError}</div>}
    <div className="runner-history">{commandsFor(state.commands?.entries ?? [], history?.source).map((record) => <article key={record.id}><code>{commandLabel(record)}</code>{record.needs_edit && <span className="runtime-error"> · {t("runnerEntry.needsEdit")}</span>}<pre>{JSON.stringify(record.args, null, 2)}</pre><small>{new Date(record.last_used_at).toLocaleString()}</small><div className="runner-inline-actions">
      <button disabled={record.needs_edit || missing.has(record.id)} onClick={() => { if (history && workspaceSourceCurrent(history.workspace, state.sourceRevision)) { state.run(record, history.source, history.workspace); close(); } }}>{t("run.run")}</button>
      <button onClick={() => { if (history && workspaceSourceCurrent(history.workspace, state.sourceRevision)) useWorkspaceRunStore.setState({ args: { workspace: history.workspace, command: record, source: history.source, module: record.entry.type === "python_module" }, history: null }); }}>{t("workspaceRun.editRun")}</button>
      <button onClick={() => { if (history && workspaceSourceCurrent(history.workspace, state.sourceRevision)) useWorkspaceRunStore.setState({ args: { workspace: history.workspace, command: record, source: history.source, module: record.entry.type === "python_module", editingId: record.id }, history: null }); }}>{t("runnerEntry.editEntry")}</button>
      <button className="danger" onClick={() => setConfirm({ title: t("workspaceRun.deleteCommand"), message: t("workspaceRun.globalDelete"), confirmLabel: t("workspaceRun.deleteCommand"), danger: true, onCancel: () => setConfirm(null), onConfirm: () => { setConfirm(null); if (history && state.commands && workspaceSourceCurrent(history.workspace, state.sourceRevision)) void api.deleteWorkspaceCommand(history.workspace, record.id, state.commands.revision).then((commands) => { if (workspaceSourceCurrent(history.workspace, state.sourceRevision)) useWorkspaceRunStore.setState({ commands }); }).catch((e) => { if (workspaceSourceCurrent(history.workspace, state.sourceRevision)) { setError(errorMessage(e)); void state.refreshCommands(); } }); } })}>{t("workspaceRun.deleteCommand")}</button>
    </div></article>)}</div>
    {!state.commands?.entries.length && <p>{t("workspaceRun.noHistory")}</p>}
    <div className="dialog-actions"><button onClick={close}>{t("workspaceRun.close")}</button></div>
  </Modal><ConfirmDialog request={confirm} /></>;
}

export function WorkspaceRunDialogs() {
  const workspace = useAppStore((s) => s.workspace), devices = useAppStore((s) => s.devices);
  const target = useAppStore((s) => s.selectedDeviceId);
  const tree=useAppStore((s)=>s.workspaceTree);
  const projectRevision=useAppStore((s)=>s.openTabs.map((tab)=>({tab,path:editorPathInWorkspace(tab,s.workspace)})).filter(({path})=>path!==null&&["pyproject.toml","uv.lock",".python-version"].includes(path)).map(({tab,path})=>`${path}:${tab.revision}`).join("|"));
  const key = workspaceKey(workspace), ready = devices.length > 0;
  const sourceRevision = workspaceSourceRevision(workspace, devices);
  useEffect(() => { void useWorkspaceRunStore.getState().load(); }, [key, ready, sourceRevision]);
  useEffect(() => { void useWorkspaceRunStore.getState().check(); }, [devices, target, projectRevision]);
  useEffect(() => { void useWorkspaceRunStore.getState().refreshCommands(); }, [tree]);
  return <><SettingsDialog /><ArgsDialog /><HistoryDialog /></>;
}
