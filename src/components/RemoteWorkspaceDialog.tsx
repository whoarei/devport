import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  deviceWorkspace, errorMessage, isRemoteWorkspaceHost, type WorkspaceEntry,
  api,
} from "../api";
import { useAppStore } from "../store";

/** 设备路径的父目录（根目录的上级仍是根目录） */
export function parentDevicePath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

/** 拼接设备上的子目录（posix 语义，根目录不产生双斜杠） */
export function joinDevicePath(path: string, name: string): string {
  return `${path.replace(/\/+$/, "")}/${name}`;
}

/** 与后端 validate_device_path 同规则：绝对路径、无 . / .. 组件、无换行 */
export function isDevicePath(path: string): boolean {
  return path.startsWith("/") && !/[\0\r\n]/.test(path) && !path.split("/").some((part) => part === "." || part === "..");
}

/**
 * 「打开设备工作区」对话框：选宿主设备 + 输入/浏览设备上的目录。
 * 目录浏览用 list_workspace_dir 单层懒加载（后端会建立编辑会话，成功即视为校验通过）。
 */
export function RemoteWorkspaceDialog() {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.remoteWorkspaceDialogOpen);
  const devices = useAppStore((s) => s.devices);
  const close = useAppStore((s) => s.closeRemoteWorkspaceDialog);
  const hosts = useMemo(() => devices.filter(isRemoteWorkspaceHost), [devices]);

  const [deviceId, setDeviceId] = useState("");
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const wasOpen = useRef(false);
  const sequence = useRef(0);

  // 打开时用宿主设备的默认工作区根作为起点
  useEffect(() => {
    if (open && !wasOpen.current) {
      const first = hosts[0];
      setDeviceId(first?.id ?? "");
      setPath(first?.workspace_root ?? "/");
      setEntries([]);
      setError(null);
      setOpening(false);
    }
    wasOpen.current = open;
  }, [open, hosts]);

  const valid = isDevicePath(path);

  const refresh = useCallback(async (id: string, dir: string) => {
    const current = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const list = await api.listWorkspaceDir(deviceWorkspace(id, dir), "");
      if (current !== sequence.current) return;
      setEntries(list.filter((entry) => entry.is_dir));
    } catch (e) {
      // 输入过程中路径可能暂时不存在：保留上一次成功的列表，只提示错误
      if (current === sequence.current) setError(errorMessage(e));
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }, []);

  // 路径或设备变化后短暂防抖再列目录，避免逐字符建连
  useEffect(() => {
    if (!open || !deviceId || !valid) {
      setEntries([]);
      return;
    }
    const timer = setTimeout(() => void refresh(deviceId, path), 400);
    return () => clearTimeout(timer);
  }, [open, deviceId, path, valid, refresh]);

  if (!open) return null;

  const selectDevice = (id: string) => {
    const device = hosts.find((item) => item.id === id);
    setDeviceId(id);
    setPath(device?.workspace_root ?? "/");
    setEntries([]);
    setError(null);
  };

  const submit = async () => {
    setOpening(true);
    setError(null);
    try {
      await useAppStore.getState().setWorkspace(deviceWorkspace(deviceId, path));
      close();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="modal-mask" onClick={close}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h3>{t("workspace.remoteTitle")}</h3>
        {hosts.length === 0 ? (
          <p className="field-hint">{t("workspace.remoteNoDevices")}</p>
        ) : <>
          <label>
            {t("workspace.remoteDevice")}
            <select value={deviceId} onChange={(event) => selectDevice(event.target.value)}>
              {hosts.map((device) => (
                <option key={device.id} value={device.id}>{device.name} · {device.transport}</option>
              ))}
            </select>
          </label>
          <label>
            {t("workspace.remotePath")}
            <input
              value={path}
              placeholder="/home/user/project"
              onChange={(event) => setPath(event.target.value)}
            />
          </label>
          <div className="remote-browser">
            <div className="remote-browser-bar">
              <span className="remote-browser-title">{t("workspace.remoteBrowse")}</span>
              <button type="button" disabled={path === "/"} onClick={() => setPath(parentDevicePath(path))}>
                {t("workspace.remoteUp")}
              </button>
              <button type="button" disabled={!valid || loading} onClick={() => void refresh(deviceId, path)}>
                {t("workspace.remoteRefresh")}
              </button>
            </div>
            {loading && <p className="field-hint">{t("workspace.remoteLoading")}</p>}
            {!loading && valid && entries.length === 0 && <p className="field-hint">{t("workspace.remoteEmpty")}</p>}
            <ul className="remote-browser-list">
              {entries.map((entry) => (
                <li key={entry.name}>
                  <button type="button" onClick={() => setPath(joinDevicePath(path, entry.name))}>
                    📁 {entry.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <p className="field-hint">{t("workspace.remoteHint")}</p>
        </>}
        <div className="modal-actions">
          <button type="button" onClick={close}>{t("workspace.remoteCancel")}</button>
          <button
            type="button"
            className="primary"
            disabled={opening || !deviceId || !valid || !path.trim()}
            onClick={() => void submit()}
          >
            {t("workspace.remoteOpen")}
          </button>
        </div>
        {error && <pre className="test-result">{error}</pre>}
      </div>
    </div>
  );
}
