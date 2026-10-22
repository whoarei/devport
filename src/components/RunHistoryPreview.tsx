import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { RunStatus } from "../api";
import { historyArgs, historyCommand, historyDuration, historyIsPython, historyPython, historySettings, historyWorkspace, historyWorkspacePath } from "../runHistory";
import { runStateLabel } from "../runState";

export function RunHistorySummary({ run, detailed = false }: { run: RunStatus; detailed?: boolean }) {
  const { t } = useTranslation(), replay = run.replay;
  const settings = replay ? historySettings(replay) : null;
  return <dl className="run-history-summary">
    <dt>{t("runHistory.command")}</dt><dd><code>{replay ? historyCommand(replay) : run.label}</code></dd>
    {replay && <><dt>{t("runHistory.args")}</dt><dd><code>{JSON.stringify(historyArgs(replay))}</code></dd>
      <dt>{t("runHistory.workspace")}</dt><dd>{historyWorkspacePath(historyWorkspace(replay))}</dd></>}
    <dt>{t("runHistory.device")}</dt><dd>{run.device_name}{replay?.device_target && ` · ${replay.device_target}`}</dd>
    {replay && settings && <><dt>{t("runHistory.environment")}</dt><dd>{historyIsPython(replay) ? t(historyPython(replay) === "project" ? "workspaceRun.project" : "workspaceRun.system") : replay.request.kind === "command" ? t("workspaceRun.presetShell") : "Bash"}{replay.launch?.version && ` · ${replay.launch.version}`}{detailed && replay.launch?.program && <code className="history-program">{replay.launch.program}</code>}</dd>
      <dt>{t("runHistory.cwd")}</dt><dd>{settings.cwd}{detailed && replay.launch?.cwd && ` → ${replay.launch.cwd}`}</dd>
      <dt>{t("runHistory.consoleMode")}</dt><dd>{settings.console_mode} · {t("runHistory.timeout")}: {settings.timeout_secs || t("runHistory.unlimited")}</dd>
      <dt>{t("runHistory.envVars")}</dt><dd>{detailed ? <details><summary>{Object.keys(settings.env).join(", ") || "—"}</summary><pre>{JSON.stringify(settings.env, null, 2)}</pre></details> : t("runHistory.envSummary", { count: Object.keys(settings.env).length })}</dd></>}
    <dt>{t("runHistory.started")}</dt><dd>{run.started_at ? new Date(run.started_at).toLocaleString() : "—"}</dd>
    <dt>{t("runHistory.result")}</dt><dd>{runStateLabel(run.state)}{run.exit_code != null && ` · ${t("runHistory.exitCode")} ${run.exit_code}`}{historyDuration(run) && ` · ${historyDuration(run)}`}</dd>
    {!replay && <dd className="history-legacy">{t("runHistory.legacy")}</dd>}
  </dl>;
}

export function RunHistoryPreview({ run, anchor, id, close, keep, leave }: { run: RunStatus; anchor: DOMRect; id: string; close: () => void; keep: () => void; leave: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const position = () => {
      const { width, height } = el.getBoundingClientRect();
      let x = anchor.right + 8;
      if (x + width > window.innerWidth - 8) x = anchor.left - width - 8;
      el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
      el.style.top = `${Math.max(8, Math.min(anchor.top, window.innerHeight - height - 8))}px`;
    };
    position(); const observer = new ResizeObserver(position); observer.observe(el);
    return () => observer.disconnect();
  }, [anchor, run.run_id]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const scroll = (e: Event) => { if (!ref.current?.contains(e.target as Node)) close(); };
    window.addEventListener("blur", close); window.addEventListener("resize", close); window.addEventListener("keydown", escape); window.addEventListener("scroll", scroll, true);
    return () => { window.removeEventListener("blur", close); window.removeEventListener("resize", close); window.removeEventListener("keydown", escape); window.removeEventListener("scroll", scroll, true); };
  }, [close]);
  return createPortal(<div ref={ref} id={id} role="tooltip" className="run-history-preview" onMouseEnter={keep} onMouseLeave={leave}><RunHistorySummary run={run} /></div>, document.body);
}
