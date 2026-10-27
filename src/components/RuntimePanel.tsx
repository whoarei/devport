import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { api, errorMessage, ManagedRuntimeInfo, ProjectEnvironmentInfo } from "../api";
import { useAppStore } from "../store";
import { ConfirmDialog, ConfirmRequest } from "./ConfirmDialog";
import { PanelTitle } from "./PanelTitle";
import { useWorkspaceRunStore } from "../workspaceRunStore";
import { preserveContentFocus } from "../focus";

/** Managed Python Runtime 管理面板：Runtime 摘要 + 项目环境列表 + 重建/删除/清理 */
export function RuntimePanel({ collapsed, onToggleCollapse }: { collapsed: boolean; onToggleCollapse: () => void }) {
  const { t } = useTranslation();
  const { selectedDeviceId, devices, workspace } = useAppStore(useShallow((s) => ({
    selectedDeviceId: s.selectedDeviceId, devices: s.devices, workspace: s.workspace,
  })));
  const device = devices.find((d) => d.id === selectedDeviceId) ?? null;
  const isSerial = device?.transport === "serial";
  // 项目环境重建走本机 uv 检查：仅本机工作区有可 inspect 的本地目录
  const workspaceDir = workspace != null;

  const [runtime, setRuntime] = useState<ManagedRuntimeInfo | null>(null);
  const [envs, setEnvs] = useState<ProjectEnvironmentInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const epoch=useRef(0);

  const refresh = useCallback(async () => {
    const token=++epoch.current;
    setRuntime(null);setEnvs([]);setError(null);
    if (!selectedDeviceId || isSerial) {
      setRuntime(null);
      setEnvs([]);
      return;
    }
    try {
      const [rt, list] = await Promise.all([
        api.listManagedRuntimes(selectedDeviceId),
        api.listProjectEnvironments(selectedDeviceId),
      ]);
      if(token!==epoch.current) return;
      setRuntime(rt);
      setEnvs(list);
      setError(null);
    } catch (e) {
      if(token===epoch.current) setError(errorMessage(e));
    }
  }, [selectedDeviceId, isSerial, device?.revision]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rebuild = async () => {
    if (selectedDeviceId && workspace) useWorkspaceRunStore.getState().prepare(true);
  };

  const askDelete = (env: ProjectEnvironmentInfo) => {
    setConfirm({
      title: t("runtime.deleteTitle"),
      message: t("runtime.deleteMessage", { id: env.id.slice(0, 8) }),
      confirmLabel: t("runtime.deleteConfirm"),
      danger: true,
      onCancel: () => setConfirm(null),
      onConfirm: () => {
        setConfirm(null);
        setBusy(env.id);
        void api.deleteProjectEnvironment(selectedDeviceId!, env.id)
          .then(refresh)
          .catch((e) => setError(errorMessage(e)))
          .finally(() => setBusy(null));
      },
    });
  };

  const askClean = () => {
    setConfirm({
      title: t("runtime.cleanTitle"),
      message: t("runtime.cleanMessage"),
      confirmLabel: t("runtime.cleanConfirm"),
      danger: true,
      onCancel: () => setConfirm(null),
      onConfirm: () => {
        setConfirm(null);
        setBusy("clean");
        void api.cleanRuntimeCache(selectedDeviceId!)
          .then(() => refresh())
          .catch((e) => setError(errorMessage(e)))
          .finally(() => setBusy(null));
      },
    });
  };

  const content = useMemo(() => {
    if (!device) return <div className="empty">{t("runtime.noDevice")}</div>;
    if (isSerial) return <div className="empty">{t("runtime.serialUnsupported")}</div>;
    return (
      <>
        <div className="runtime-section">
          <div className="runtime-heading">{t("runtime.runtimeHeading")}</div>
          {runtime && (
            <div className="runtime-row" title={runtime.uv_path}>
              <span>uv {runtime.uv_version}</span>
              <span className="secondary-text">{runtime.platform}</span>
              <span className={`run-state ${runtime.present ? "state-running" : "state-failed"}`}>
                {runtime.present ? t("runtime.present") : t("runtime.absent")}
              </span>
            </div>
          )}
        </div>
        <div className="runtime-section">
          <div className="runtime-heading">{t("runtime.envHeading")}</div>
          <ul className="runtime-environments">
            {envs.map((env) => (
              <li key={env.id} title={env.path}>
                <span className={`run-state ${env.ready ? "state-running" : "state-preparing"}`}>
                  {env.ready ? t("runtime.ready") : t("runtime.notReady")}
                </span>
                <span className="runtime-environment-name">
                  {env.id.slice(0, 8)}
                  {env.manifest ? ` · Python ${env.manifest.python_version}` : ""}
                  {env.leased ? ` · ${t("runtime.leased")}` : ""}
                </span>
                <span className="secondary-text">
                  {env.manifest
                    ? `uv ${env.manifest.uv_version} · lock ${env.manifest.lock_sha256.slice(0, 8)} · ${new Date(env.manifest.last_used_at).toLocaleString()}`
                    : t("runtime.noManifest")}
                </span>
                <button
                  className="danger"
                  disabled={env.leased || busy === env.id}
                  title={env.leased ? t("runtime.leasedTitle") : undefined}
                  onClick={() => askDelete(env)}
                >
                  {t("runtime.delete")}
                </button>
              </li>
            ))}
            {envs.length === 0 && <li className="empty">{t("runtime.envEmpty")}</li>}
          </ul>
        </div>
      </>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device, isSerial, runtime, envs, busy, t]);

  return (
    <div className="runtime-panel">
      <PanelTitle title={t("runtime.title")} collapsed={collapsed} onToggle={onToggleCollapse} />
      {!collapsed && (
        <>
          <div className="runtime-actions">
            <button disabled={!device || isSerial || busy != null} onMouseDown={preserveContentFocus} onClick={() => void refresh()}>
              {t("runtime.refresh")}
            </button>
            <button
              disabled={!device || isSerial || !workspaceDir || busy != null}
              title={workspaceDir ? t("runtime.rebuildTitle") : t("runtime.rebuildNeedWorkspace")}
              onMouseDown={preserveContentFocus}
              onClick={() => void rebuild()}
            >
              {busy === "rebuild" ? t("runtime.rebuilding") : t("runtime.rebuild")}
            </button>
            <button className="danger" disabled={!device || isSerial || busy != null} onClick={askClean}>
              {busy === "clean" ? t("runtime.cleaning") : t("runtime.clean")}
            </button>
          </div>
          {device && !isSerial && (
            <div className="secondary-text runtime-device">{device.name}</div>
          )}
          {error && <div className="runtime-error">{error}</div>}
          {content}
        </>
      )}
      <ConfirmDialog request={confirm} />
    </div>
  );
}
