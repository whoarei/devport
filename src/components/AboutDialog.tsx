import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { productName, version as buildVersion } from "../../src-tauri/tauri.conf.json";
import appIcon from "../../src-tauri/icons/128x128@2x.png";
import { api, errorMessage, type AppUpdateInfo } from "../api";
import { installCheckedUpdate } from "../updateFlow";
import { formatDownloadProgress, updateInstallBlocker } from "../updateStatus";
import { useAppStore } from "../store";
import { transferActive } from "../transferApi";
import { useTransferStore } from "../transferStore";

const PROJECT_URL = "https://github.com/whoarei/devport";
const RELEASES_URL = `${PROJECT_URL}/releases/latest`;

type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "available"; info: AppUpdateInfo }
  | { kind: "closingTerminals" }
  | { kind: "downloading"; info: AppUpdateInfo; downloaded: number; total: number | null }
  | { kind: "verifying" }
  | { kind: "installing" }
  | { kind: "error"; message: string };

interface UpdateSectionProps {
  autoCheckNonce: number;
}

/** 检查更新 + 升级操作区。方案 A（安装形态）应用内自动升级，方案 B（portable）回退手动下载。 */
function UpdateSection({ autoCheckNonce }: UpdateSectionProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<UpdatePhase>({ kind: "idle" });
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const runBlocker = useAppStore(updateInstallBlocker);
  const updating = useAppStore((s) => s.updating);
  const transferBusy = useTransferStore((s) => s.tasks.some((task) => transferActive(task.state)));
  const blocker = runBlocker || (transferBusy ? t("transfer.updateBlocker") : null);

  const check = useCallback(async () => {
    if (busyRef.current || useAppStore.getState().updating) return;
    busyRef.current = true;
    setPhase({ kind: "checking" });
    try {
      const info = await api.checkAppUpdate();
      if (mounted.current) setPhase(info ? { kind: "available", info } : { kind: "uptodate" });
    } catch (error) {
      if (mounted.current) setPhase({ kind: "error", message: errorMessage(error) });
    } finally { busyRef.current = false; }
  }, []);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (autoCheckNonce > 0) void check();
  }, [autoCheckNonce, check]);

  const install = useCallback(async (info: AppUpdateInfo) => {
    if (busyRef.current || useAppStore.getState().updating) return;
    const blocked = updateInstallBlocker(useAppStore.getState());
    if (blocked) { setPhase({ kind: "error", message: blocked }); return; }
    busyRef.current = true;
    try {
      await installCheckedUpdate(info, (phase) => {
        if (!mounted.current) return;
        if (phase.kind === "checking") return;
        if (phase.kind === "downloading") setPhase({ kind: "downloading", info, downloaded: phase.downloaded, total: phase.total });
        else setPhase({ kind: phase.kind });
      });
      if (mounted.current) setPhase({ kind: "available", info });
    } catch (error) {
      if (mounted.current) setPhase({ kind: "error", message: t("about.installFailed", { message: errorMessage(error) }) });
    } finally {
      busyRef.current = false;
    }
  }, [t]);

  const openDownload = useCallback(() => {
    void openUrl(RELEASES_URL).catch((error) => {
      setPhase({ kind: "error", message: t("update.openBrowserFailed", { message: errorMessage(error) }) });
    });
  }, [t]);

  const busy = updating || phase.kind === "checking" || phase.kind === "closingTerminals" || phase.kind === "downloading" || phase.kind === "verifying" || phase.kind === "installing";

  return (
    <section className="about-update" data-phase={phase.kind} aria-label={t("about.checkAria")} aria-live="polite">
      <div className="about-update-heading">
        <div>
          <h3>{t("about.updateTitle")}</h3>
          {phase.kind === "idle" && <p className="about-update-hint">{t("about.updateHint")}</p>}
        </div>
        <button type="button" className={`about-check-button${phase.kind === "available" ? "" : " primary"}`} disabled={busy} onClick={() => void check()}>
          {phase.kind === "checking" ? t("about.checking") : t("about.check")}
        </button>
      </div>
      {phase.kind === "uptodate" && <p className="about-update-status">{t("about.upToDate")}</p>}
      {phase.kind === "available" && (
        <div className="about-update-status">
          <p>{t("about.available", { latest: phase.info.latest_version, current: phase.info.current_version })}</p>
          {!phase.info.can_auto_install && <p>{t("about.manualOnly")}</p>}
          {phase.info.can_auto_install && blocker && <p className="about-update-error">{blocker}</p>}
          <div className="about-update-actions">
            {phase.info.can_auto_install && (
              <button type="button" className="primary" disabled={busy || !!blocker} onClick={() => void install(phase.info)}>{t("about.installButton")}</button>
            )}
            <button type="button" onClick={openDownload}>{t("about.openDownload")}</button>
          </div>
          {phase.info.can_auto_install && <p>{t("about.restartHint")}</p>}
          {phase.info.notes && (
            <details className="about-release-notes">
              <summary>{t("about.releaseNotes")}</summary>
              <pre className="about-update-notes">{phase.info.notes}</pre>
            </details>
          )}
        </div>
      )}
      {phase.kind === "closingTerminals" && <p className="about-update-status">{t("update.closingTerminals")}</p>}
      {phase.kind === "downloading" && (
        <div className="about-update-status">
          <progress aria-label={t("about.downloadProgress")} value={phase.total ? phase.downloaded : undefined} max={phase.total ?? undefined} />
          <p>{formatDownloadProgress(phase.downloaded, phase.total)}</p>
        </div>
      )}
      {phase.kind === "verifying" && <p className="about-update-status">{t("about.verifying")}</p>}
      {phase.kind === "installing" && <p className="about-update-status">{t("about.installing")}</p>}
      {phase.kind === "error" && (
        <div className="about-update-status">
          <p className="about-update-error">{phase.message}</p>
          <div className="about-update-actions"><button type="button" onClick={openDownload}>{t("about.openDownload")}</button></div>
        </div>
      )}
    </section>
  );
}

export function AboutDialog({ dialogRef, autoCheckNonce = 0 }: { dialogRef: RefObject<HTMLDialogElement>; autoCheckNonce?: number }) {
  const { t } = useTranslation();
  const [version, setVersion] = useState(buildVersion);
  const [linkError, setLinkError] = useState<string | null>(null);
  const updating = useAppStore((state) => state.updating);
  // Native showModal() should focus the introduction without scrolling to an
  // action below the fold. React's autoFocus does not write the native attribute.
  const headingRef = useCallback((heading: HTMLHeadingElement | null) => {
    heading?.setAttribute("autofocus", "");
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    // Use installed app metadata; the build config also supports browser previews.
    void getVersion().then((value) => { if (!disposed) setVersion(value); }).catch(() => {});
    return () => { disposed = true; };
  }, []);

  return (
    <dialog ref={dialogRef} className="about-dialog" aria-labelledby="about-title" aria-describedby="about-description"
      onCancel={(event) => { if (useAppStore.getState().updating) event.preventDefault(); }}
      onClick={(event) => {
        if (useAppStore.getState().updating) return;
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
          event.currentTarget.close();
        }
      }}>
      <header className="about-hero">
        <div className="about-heading">
          <img className="about-logo" src={appIcon} alt="" width="72" height="72" />
          <div className="about-brand">
            <p className="about-eyebrow">{t("about.tagline")}</p>
            <h2 id="about-title" ref={headingRef} tabIndex={-1} aria-label={t("about.title", { name: productName })}>{productName}</h2>
            <p className="about-version">{t("about.version", { version })}</p>
          </div>
        </div>
        <p id="about-description" className="about-description">{t("about.description")}</p>
      </header>
      <div className="about-content">
        <ul className="about-capabilities" aria-label={t("about.features")}>
          <li>
            <svg className="about-feature-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" /><path d="M3 11h18" />
            </svg>
            <h3>{t("about.workspaceTitle")}</h3>
            <p>{t("about.workspaceDescription")}</p>
          </li>
          <li>
            <svg className="about-feature-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" />
            </svg>
            <h3>{t("about.executionTitle")}</h3>
            <p>{t("about.executionDescription")}</p>
          </li>
          <li>
            <svg className="about-feature-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4" />
            </svg>
            <h3>{t("about.transferTitle")}</h3>
            <p>{t("about.transferDescription")}</p>
          </li>
        </ul>
        <div className="about-targets">
          <span className="about-targets-label">{t("about.runTargets")}</span>
          <ul className="about-transports" aria-label={t("about.transportsAria")}>
            <li>{t("about.localShell")}</li>
            <li>SSH</li>
            <li>WSL</li>
            <li>{t("about.serialShell")}</li>
          </ul>
        </div>
      </div>
      {isTauri() && <UpdateSection autoCheckNonce={autoCheckNonce} />}
      {linkError && <p className="about-link-error" role="alert">{linkError}</p>}
      <footer className="about-footer">
        <a className="about-project-link" href={PROJECT_URL} target="_blank" rel="noreferrer" onClick={(event) => {
          if (!isTauri()) return;
          event.preventDefault();
          setLinkError(null);
          void openUrl(PROJECT_URL).catch((error) => setLinkError(t("update.openBrowserFailed", { message: errorMessage(error) })));
        }}>
          {t("about.projectLink")}
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 2.5h4.5V7m0-4.5L7 9m-1-6H3a.5.5 0 0 0-.5.5V13a.5.5 0 0 0 .5.5h9.5a.5.5 0 0 0 .5-.5v-3" /></svg>
        </a>
        <form method="dialog"><button type="submit" className="about-close" disabled={updating}>{t("about.close")}</button></form>
      </footer>
    </dialog>
  );
}
