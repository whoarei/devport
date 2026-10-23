import { useEffect, useRef, useState, type KeyboardEventHandler, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, errorMessage } from "../api";
import { useAppStore } from "../store";
import { useRunHistoryStore } from "../runHistoryStore";
import { decodeHistoryOutput, historyArgs, historyIsPython, historyPython, historySettings, historyWorkspace, historyWorkspacePath } from "../runHistory";
import { workspaceSourceRevision } from "../workspaceRun";
import { isActiveRun } from "../runState";
import { RunHistorySummary } from "./RunHistoryPreview";
import { RunReplayButton } from "./RunReplayButton";
import { deviceLabel } from "./DeviceDialog";
import { handleRunShortcut, parseRunArguments } from "../runArguments";
import { ArgumentsEditor } from "./ArgumentsEditor";

function Modal({ open, title, close, children, onKeyDown }: { open: boolean; title: string; close: () => void; children: ReactNode; onKeyDown?: KeyboardEventHandler<HTMLDialogElement> }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = ref.current; if (open && el && !el.open) el.showModal(); if (!open && el?.open) el.close(); }, [open]);
  return <dialog className="runner-dialog history-dialog" ref={ref} aria-label={title} onKeyDown={onKeyDown} onCancel={e => { e.preventDefault(); close(); }}><h3>{title}</h3>{children}</dialog>;
}

function DetailsDialog() {
  const { t } = useTranslation(), state = useRunHistoryStore();
  const run = useAppStore(s => state.detailId ? s.runs[state.detailId] : null);
  const [output, setOutput] = useState(""), [error, setError] = useState<string | null>(null);
  const live = !!run && isActiveRun(run);
  useEffect(() => {
    let canceled = false, timer: ReturnType<typeof setTimeout>;
    setOutput(""); setError(null);
    const id = state.detailId;
    if (!id) return;
    const read = async () => {
      try { const data = await api.readRunHistoryOutput(id); if (!canceled) { setOutput(decodeHistoryOutput(data)); setError(null); } }
      catch (e) { if (!canceled) setError(errorMessage(e)); }
      if (!canceled && live) timer = setTimeout(read, 1000);
    };
    void read(); return () => { canceled = true; clearTimeout(timer); };
  }, [state.detailId, live]);
  return <Modal open={!!run} title={t("runHistory.details")} close={() => state.view(null)}>
    {run && <><RunHistorySummary run={run} detailed />
      {run.error && <div className="runtime-error">{run.error}</div>}
      <h4>{t("runHistory.logs")}</h4>
      {error && <div role="alert" className="runtime-error">{error}</div>}
      <pre className="history-output">{output || t("runHistory.noOutput")}</pre>
      {run.output_truncated && <p className="secondary-text">{t("runHistory.outputTruncated")}</p>}
      <div className="dialog-actions">{live && <button className="danger" onClick={() => void api.stopRun(run.run_id).catch(e => setError(errorMessage(e)))}>{t("run.stop")}</button>}<RunReplayButton run={run} showShortcut={false} /><button onClick={() => state.view(null)}>{t("workspaceRun.close")}</button></div>
    </>}
  </Modal>;
}

function EditDialog() {
  const { t } = useTranslation(), state = useRunHistoryStore(), draft = state.draft;
  const devices = useAppStore(s => s.devices);
  const [deviceId, setDeviceId] = useState(""), [entry, setEntry] = useState(""), [argsText, setArgsText] = useState("");
  const [python, setPython] = useState<"project" | "device_default">("device_default"), [cwd, setCwd] = useState("."), [env, setEnv] = useState("{}");
  const [mode, setMode] = useState<"pty" | "pipe">("pty"), [timeout, setTimeoutValue] = useState(0), [bash, setBash] = useState("");
  const [error, setError] = useState<string | null>(null);
  const target = devices.find(d => d.id === deviceId);
  useEffect(() => {
    if (!draft) return;
    const replay = draft.replay, settings = historySettings(replay), command = replay.workspace_request?.command;
    setDeviceId(draft.deviceId); setEntry(command ? command.entry.type === "python_module" ? command.entry.name : command.entry.path : replay.request.command ?? replay.request.entry ?? "");
    setArgsText(historyArgs(replay).join("\n")); setPython(historyPython(replay)); setCwd(settings.cwd); setEnv(JSON.stringify(settings.env, null, 2));
    setMode(settings.console_mode); setTimeoutValue(settings.timeout_secs); setBash(settings.bash ?? ""); setError(null);
  }, [draft]);
  const close = () => { if (!state.busy) useRunHistoryStore.setState({ draft: null, error: null }); };
  const args = draft?.replay.request.kind === "command" ? historyArgs(draft.replay) : parseRunArguments(argsText);
  const canSubmit = !state.busy && !!target?.revision && !!entry.trim() && Number.isSafeInteger(timeout) && timeout >= 0 && timeout <= 31536000;
  const submit = () => {
    if (!draft || !target?.revision || !canSubmit) return;
    try {
      const variables = JSON.parse(env);
      if (!variables || Array.isArray(variables) || typeof variables !== "object" || Object.values(variables).some(v => typeof v !== "string")) throw new Error(t("workspaceRun.envInvalid"));
      const replay = structuredClone(draft.replay);
      const settings = { cwd, env: variables, console_mode: mode, timeout_secs: timeout, bash: bash || undefined };
      if (replay.workspace_request) {
        const command = replay.workspace_request.command;
        command.entry = command.entry.type === "python_module" ? { type: "python_module", name: entry } : { ...command.entry, path: entry };
        command.args = args.slice(); replay.workspace_request.python = python;
        replay.workspace_request.settings = { ...replay.workspace_request.settings, ...settings };
      } else {
        if (replay.request.kind === "command") replay.request.command = entry;
        else replay.request.entry = entry;
        Object.assign(replay.request, settings, { args: args.slice(), managed_python: python === "project" && replay.request.kind === "python" });
      }
      void state.submit({ ...draft, replay, deviceId, deviceRevision: target.revision, sourceRevision: workspaceSourceRevision(historyWorkspace(replay), devices) });
    } catch (e) { setError(errorMessage(e)); }
  };
  return <Modal open={!!draft} title={t("runHistory.edit")} close={close} onKeyDown={e => handleRunShortcut(e, submit)}>
    {draft && <>
      <p className="runner-location">{t("runHistory.workspace")}: {historyWorkspacePath(historyWorkspace(draft.replay))}</p>
      {draft.notice && <p className="runtime-error" role="alert">{draft.notice}</p>}
      <label>{t("workspaceRun.target")}<select value={target ? deviceId : ""} disabled={state.busy} onChange={e => setDeviceId(e.target.value)}><option value="" disabled>{t("runHistory.missingTarget")}</option>{devices.map(d => <option key={d.id} value={d.id}>{deviceLabel(d)}</option>)}</select></label>
      <label>{t(draft.replay.request.kind === "command" ? "runHistory.command" : "runHistory.entry")}<textarea rows={2} disabled={state.busy} value={entry} onChange={e => setEntry(e.target.value)} /></label>
      {draft.replay.request.kind !== "command" && <ArgumentsEditor value={argsText} onChange={setArgsText} disabled={state.busy}
        preview={[...(draft.replay.workspace_request?.command.entry.type === "python_module" ? ["-m", entry] : [entry]), ...args]} />}
      {historyIsPython(draft.replay) && <label>{t("workspaceRun.python")}<select disabled={state.busy} value={python} onChange={e => setPython(e.target.value as typeof python)}><option value="device_default">{t("workspaceRun.system")}</option><option value="project" disabled={target?.transport === "serial"}>{t("workspaceRun.project")}</option></select></label>}
      {draft.replay.workspace_request && <label>{t("runHistory.cwd")}<input disabled={state.busy} value={cwd} onChange={e => setCwd(e.target.value)} /></label>}
      <label>{t("runHistory.envVars")}<textarea rows={3} disabled={state.busy} value={env} onChange={e => setEnv(e.target.value)} /></label>
      <div className="runner-inline-actions"><label>{t("runHistory.consoleMode")}<select disabled={state.busy} value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="pty">PTY</option><option value="pipe" disabled={target?.transport === "serial"}>pipe</option></select></label><label>{t("runHistory.timeout")}<input type="number" min={0} max={31536000} disabled={state.busy} value={timeout} onChange={e => setTimeoutValue(e.target.valueAsNumber)} /></label></div>
      {target?.transport === "local" && draft.replay.request.kind === "shell" && <label>{t("workspaceRun.bash")}<select disabled={state.busy} value={bash} onChange={e => setBash(e.target.value)}><option value="">{t("workspaceRun.autoBash")}</option><option value="bash">Bash</option><option value="gitbash">Git Bash</option><option value="msys2">MSYS2</option></select></label>}
      {error && <div className="runtime-error" role="alert">{error}</div>}
      <div className="dialog-actions"><button disabled={state.busy} onClick={close}>{t("dialog.cancel")}</button><button className="primary" disabled={!canSubmit} onClick={submit} title={t("workspaceRun.runShortcut")}>{t("run.run")}</button></div>
    </>}
  </Modal>;
}

export function RunHistoryDialogs() { return <><DetailsDialog /><EditDialog /></>; }
