import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type RunStatus } from "../api";
import { isActiveRun, runDuration } from "../runState";

export function RunElapsed({ run }: { run: RunStatus }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const live = isActiveRun(run);
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live, run.run_id]);
  const duration = !live && !run.ended_at ? null : runDuration(run.started_at, run.ended_at, now);
  return duration && <span className="run-elapsed" title={t("run.elapsed")} aria-label={t("run.elapsedValue", { duration })}>{duration}</span>;
}
