import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { productName, version as buildVersion } from "../../src-tauri/tauri.conf.json";
import appIcon from "../../src-tauri/icons/128x128.png";
import { api, errorMessage, type AppUpdateInfo } from "../api";
import { installCheckedUpdate } from "../updateFlow";
import { formatDownloadProgress, updateInstallBlocker } from "../updateStatus";
import { useAppStore } from "../store";
import { transferActive } from "../transferApi";
import { useTransferStore } from "../transferStore";

const RELEASES_URL = "https://github.com/whoarei/remote-runner/releases/latest";

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
    <section className="about-update" aria-label={t("about.checkAria")} aria-live="polite">
      <div className="about-update-row">
        <button type="button" className="primary" disabled={busy} onClick={() => void check()}>
          {phase.kind === "checking" ? t("about.checking") : t("about.check")}
        </button>
        {phase.kind === "available" && (
          <>
            {phase.info.can_auto_install && (
              <button type="button" disabled={busy || !!blocker} onClick={() => void install(phase.info)}>{t("about.installButton")}</button>
            )}
            <button type="button" onClick={openDownload}>{t("about.openDownload")}</button>
          </>
        )}
        {phase.kind === "error" && (
          <button type="button" onClick={openDownload}>{t("about.openDownload")}</button>
        )}
      </div>
      {phase.kind === "uptodate" && <p className="about-update-status">{t("about.upToDate")}</p>}
      {phase.kind === "available" && (
        <div className="about-update-status">
          <p>
            {t("about.available", { latest: phase.info.latest_version, current: phase.info.current_version })}
            {!phase.info.can_auto_install && t("about.manualOnly")}
          </p>
          {phase.info.can_auto_install && blocker && <p className="about-update-error">{blocker}</p>}
          {phase.info.notes && <pre className="about-update-notes">{phase.info.notes}</pre>}
        </div>
      )}
      {phase.kind === "closingTerminals" && <p className="about-update-status">{t("update.closingTerminals")}</p>}
      {phase.kind === "downloading" && (
        <div className="about-update-status">
          <progress value={phase.total ? phase.downloaded : undefined} max={phase.total ?? undefined} />
          <p>{formatDownloadProgress(phase.downloaded, phase.total)}</p>
        </div>
      )}
      {phase.kind === "verifying" && <p className="about-update-status">{t("about.verifying")}</p>}
      {phase.kind === "installing" && <p className="about-update-status">{t("about.installing")}</p>}
      {phase.kind === "error" && <p className="about-update-status about-update-error">{phase.message}</p>}
    </section>
  );
}

export function AboutDialog({ dialogRef, autoCheckNonce = 0 }: { dialogRef: RefObject<HTMLDialogElement>; autoCheckNonce?: number }) {
  const { t } = useTranslation();
  const [version, setVersion] = useState(buildVersion);
  const updating = useAppStore((state) => state.updating);

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
      <div className="about-heading">
        <img className="about-logo" src={appIcon} alt="" width="40" height="40" />
        <div>
          <h2 id="about-title">{t("about.title", { name: productName })}</h2>
          <p className="about-version">{t("about.version", { version })}</p>
        </div>
      </div>
      <p id="about-description">{t("about.description")}</p>
      <ul className="about-transports" aria-label={t("about.transportsAria")}>
        <li>SSH</li>
        <li>{t("about.serialShell")}</li>
        <li>WSL</li>
        <li>{t("about.localShell")}</li>
      </ul>
      <p className="about-features">{t("about.features")}</p>
      {isTauri() && <UpdateSection autoCheckNonce={autoCheckNonce} />}
      <form method="dialog" className="dialog-actions">
        <button type="submit" disabled={updating} autoFocus>{t("about.close")}</button>
      </form>
    </dialog>
  );
}
