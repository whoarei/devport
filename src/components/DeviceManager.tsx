import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, type DeviceProfile } from "../api";
import { deleteDevice, reorderDevices, saveDevice } from "../deviceActions";
import { automaticDeviceName } from "../deviceNaming";
import { useAppStore } from "../store";
import { DeviceEditor, DeviceIcon, deviceLabel, emptyDevice } from "./DeviceEditor";
import "./DeviceManager.css";

// List snapshots carry a revision, but it is not part of an editable draft.
const draftKey = ({ revision: _revision, ...device }: DeviceProfile) => JSON.stringify(device);

export function DeviceManager() {
  const open = useAppStore((state) => state.deviceManagerOpen);
  return open ? <DeviceManagerDialog /> : null;
}

interface Drag {
  id: string;
  ids: string[];
  pointer: number;
  handle: HTMLButtonElement;
  x: number;
  y: number;
  clientY: number;
  slot: number | null;
  active: boolean;
}

function DeviceManagerDialog() {
  const { t } = useTranslation();
  const devices = useAppStore((state) => state.devices);
  const initial = useRef(devices.find((device) => device.id === useAppStore.getState().selectedDeviceId) ?? devices[0] ?? null);
  const [editing, setEditing] = useState<DeviceProfile | null>(initial.current);
  const [baseline, setBaseline] = useState(initial.current ? draftKey(initial.current) : "");
  const [automaticName, setAutomaticName] = useState(false);
  const [editorSession, setEditorSession] = useState(0);
  const [operation, setOperation] = useState<"save" | "order" | "delete" | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<"orderSaved" | "saved">("orderSaved");
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [previewIds, setPreviewIds] = useState<string[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [insertAt, setInsertAt] = useState<number | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const prompt = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const animation = useRef<number | null>(null);
  const locked = useRef(false);
  const device = editing ? { ...editing, name: automaticName ? automaticDeviceName(editing) : editing.name } : null;
  const dirty = !!device && draftKey(device) !== baseline;
  const busy = operation !== null || testing;
  const ordered = previewIds ? previewIds.flatMap((id) => devices.find((item) => item.id === id) ?? []) : devices;
  const selectedIndex = ordered.findIndex((item) => item.id === editing?.id);

  const choose = (next: DeviceProfile | null) => {
    setEditing(next);
    setBaseline(next ? draftKey(next) : "");
    setAutomaticName(!!next && !next.id && !next.name.trim());
    setEditorSession((session) => session + 1);
  };

  useEffect(() => {
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLInputElement>("#device-name")?.focus();
    void useAppStore.getState().loadDevices().catch((e) => setError(`${t("device.refreshFailed")}: ${errorMessage(e)}`));
    return () => {
      dialog.current?.close();
      if (animation.current !== null) cancelAnimationFrame(animation.current);
    };
  }, []);

  useEffect(() => {
    const element = prompt.current;
    if (pending && !element?.open) element?.showModal();
    else if (!pending) element?.close();
  }, [pending]);

  useEffect(() => {
    if (editing?.id) {
      const current = devices.find((item) => item.id === editing.id);
      if (!current) choose(devices[0] ?? null);
      else if (!dirty && (draftKey(current) !== baseline || current.revision !== editing.revision)) choose(current);
    } else if (!editing && devices.length) choose(devices[0]);
  }, [devices, editing?.id]);

  const navigate = (action: () => void) => {
    if (locked.current || testing) return;
    if (dirty) setPending(() => action);
    else action();
  };
  const close = () => navigate(() => useAppStore.getState().closeDeviceManager());
  const add = () => navigate(() => choose({ ...emptyDevice(), is_default: useAppStore.getState().devices.length === 0 }));

  const save = async (): Promise<boolean> => {
    if (!device || locked.current || testing) return false;
    locked.current = true;
    setOperation("save");
    setError(null);
    try {
      const saved = await saveDevice(device);
      choose(saved);
      if (saved.is_default) useAppStore.getState().selectDevice(saved.id);
      setNotice("saved");
      return true;
    } catch (e) {
      setError(t("device.saveFailed", { message: errorMessage(e) }));
      return false;
    } finally {
      locked.current = false;
      setOperation(null);
    }
  };

  const reorder = async (ids: string[]) => {
    if (locked.current || testing || ids.every((id, index) => devices[index]?.id === id)) return;
    locked.current = true;
    setOperation("order");
    setPreviewIds(ids);
    setError(null);
    try {
      await reorderDevices(ids);
      setNotice("orderSaved");
    } catch (e) {
      setError(t("device.reorderFailed", { message: errorMessage(e) }));
    } finally {
      locked.current = false;
      setOperation(null);
      setPreviewIds(null);
    }
  };

  const move = (offset: number) => {
    if (selectedIndex < 0) return;
    const ids = devices.map((item) => item.id);
    const destination = selectedIndex + offset;
    if (destination < 0 || destination >= ids.length) return;
    ids.splice(destination, 0, ids.splice(selectedIndex, 1)[0]);
    void reorder(ids);
  };

  const remove = () => navigate(() => {
    if (!editing?.id) return;
    const id = editing.id;
    const index = devices.findIndex((item) => item.id === id);
    locked.current = true;
    setOperation("delete");
    setError(null);
    void deleteDevice({ id }).then((deleted) => {
      if (deleted) {
        const current = useAppStore.getState().devices;
        choose(current[Math.min(index, current.length - 1)] ?? null);
      } else setError(t("device.deleteFailed"));
    }).finally(() => { locked.current = false; setOperation(null); });
  });

  const updateInsertion = () => {
    const current = drag.current;
    const element = list.current;
    if (!current?.active || !element) return;
    const rows = [...element.querySelectorAll<HTMLElement>(".device-manager-row")];
    let slot = rows.findIndex((row) => current.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
    if (slot < 0) slot = rows.length;
    current.slot = slot;
    setInsertAt(slot);
  };
  const autoScroll = () => {
    const current = drag.current;
    const element = list.current;
    if (!current?.active || !element) return;
    const rect = element.getBoundingClientRect();
    if (current.clientY < rect.top + 30) element.scrollTop -= 10;
    else if (current.clientY > rect.bottom - 30) element.scrollTop += 10;
    updateInsertion();
    animation.current = requestAnimationFrame(autoScroll);
  };
  const stopDrag = () => {
    const current = drag.current;
    drag.current = null;
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
    if (current?.handle.hasPointerCapture(current.pointer)) current.handle.releasePointerCapture(current.pointer);
    setDragId(null);
    setInsertAt(null);
  };
  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (busy || locked.current || devices.length < 2 || event.button !== 0) return;
    drag.current = { id, ids: devices.map((item) => item.id), pointer: event.pointerId, handle: event.currentTarget, x: event.clientX, y: event.clientY, clientY: event.clientY, slot: null, active: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const dragMove = (event: ReactPointerEvent) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    current.clientY = event.clientY;
    if (!current.active) {
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 4) return;
      current.active = true;
      setDragId(current.id);
      animation.current = requestAnimationFrame(autoScroll);
    }
    const rect = list.current?.getBoundingClientRect();
    if (rect && (event.clientX < rect.left - 30 || event.clientX > rect.right + 30)) {
      stopDrag();
      return;
    }
    updateInsertion();
  };
  const drop = (event: ReactPointerEvent) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    stopDrag();
    if (!current.active || current.slot === null) return;
    if (current.ids.join("\0") !== useAppStore.getState().devices.map((item) => item.id).join("\0")) {
      setError(t("device.orderChanged"));
      return;
    }
    const ids = [...current.ids];
    const from = ids.indexOf(current.id);
    ids.splice(current.slot > from ? current.slot - 1 : current.slot, 0, ids.splice(from, 1)[0]);
    void reorder(ids);
  };

  return <>
    <dialog ref={dialog} className="device-dialog device-manager" aria-labelledby="device-manager-title"
      onCancel={(event) => { event.preventDefault(); close(); }}
      onKeyDown={(event) => { if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); stopDrag(); } }}>
      <header className="device-dialog-header">
        <div className="device-heading-icon"><DeviceIcon name="ssh" /></div>
        <div className="device-heading"><h3 id="device-manager-title">{t("device.manageTitle")}</h3><p>Remote Runner</p></div>
        <button type="button" className="device-icon-button" disabled={busy} aria-label={t("device.closeManager")} onClick={close}><DeviceIcon name="close" /></button>
      </header>
      <div className="device-manager-body">
        <aside className="device-manager-sidebar" aria-label={t("device.deviceList")}>
          <div className="device-manager-list-heading">{t("device.deviceList")}<span>{devices.length}</span></div>
          <button type="button" className="device-manager-add" disabled={busy} onClick={add}><DeviceIcon name="plus" />{t("device.addTitle")}</button>
          <div className="device-manager-list" ref={list} role="list" aria-label={t("device.deviceList")}
            onPointerMove={dragMove} onPointerUp={drop} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}>
            {ordered.map((item, index) => <div role="listitem" key={item.id} data-device-id={item.id}
              className={`device-manager-row${item.id === editing?.id ? " selected" : ""}${item.id === dragId ? " dragging" : ""}${insertAt === index ? " drop-before" : ""}${insertAt === ordered.length && index === ordered.length - 1 ? " drop-after" : ""}`}>
              <button type="button" className="device-manager-grip" disabled={busy || devices.length < 2} aria-label={t("device.dragDevice", { name: item.name })}
                onPointerDown={(event) => startDrag(event, item.id)}><DeviceIcon name="grip" /></button>
              <button type="button" className="device-manager-select" disabled={busy} aria-pressed={item.id === editing?.id} title={deviceLabel(item)}
                onClick={() => { if (editing?.id !== item.id) navigate(() => choose(useAppStore.getState().devices.find((current) => current.id === item.id) ?? null)); }}>
                <DeviceIcon name={item.transport} />
                <span className="device-manager-row-text"><span className="device-manager-row-name"><span>{item.name}</span>{item.is_default && <small>{t("device.defaultBadge")}</small>}</span><span className="device-manager-row-detail">{item.transport === "ssh" ? `${item.username}@${item.host}` : item.transport === "wsl" ? `WSL · ${item.wsl?.distribution ?? ""}` : item.transport === "local" ? item.local?.shell : `${item.serial?.port ?? ""} · ${item.serial?.baud_rate ?? ""}`}</span></span>
              </button>
            </div>)}
            {!devices.length && <p className="device-manager-empty">{t("device.emptyList")}</p>}
          </div>
          <div className="device-manager-list-footer"><span><DeviceIcon name="grip" />{t("device.dragHint")}</span><div>
            <button type="button" className="device-icon-button" disabled={busy || selectedIndex <= 0} aria-label={t("device.moveUp")} title={t("device.moveUp")} onClick={() => move(-1)}><DeviceIcon name="up" /></button>
            <button type="button" className="device-icon-button" disabled={busy || selectedIndex < 0 || selectedIndex >= ordered.length - 1} aria-label={t("device.moveDown")} title={t("device.moveDown")} onClick={() => move(1)}><DeviceIcon name="down" /></button>
          </div></div>
        </aside>
        {editing ? <DeviceEditor key={`${editing.id || "new"}:${editorSession}`} editing={editing} automaticName={automaticName} onAutomaticName={setAutomaticName}
          onChange={(patch) => setEditing((current) => current ? { ...current, ...patch } : current)} onSave={() => { void save(); }} onDelete={remove}
          dirty={dirty} busy={busy} testing={testing} onTesting={setTesting} />
          : <div className="device-manager-empty-editor"><DeviceIcon name="ssh" /><p>{t("device.emptyDescription")}</p><button type="button" onClick={add}>{t("device.addTitle")}</button></div>}
      </div>
      {error && <div className="device-manager-error" role="alert">{error}</div>}
      <footer className="device-manager-footer"><span role="status" aria-live="polite">{operation ? <span className="device-spinner" /> : <DeviceIcon name="check" />}{t(operation === "order" ? "device.orderSaving" : operation ? "device.saving" : `device.${notice}`)}</span><button type="button" disabled={busy} onClick={close}>{t("device.done")}</button></footer>
    </dialog>
    <dialog ref={prompt} className="unsaved-dialog device-changes-dialog" aria-labelledby="device-changes-title" onCancel={(event) => { event.preventDefault(); if (!busy) setPending(null); }}>
      <h3 id="device-changes-title">{t("device.savePrompt")}</h3><p>{t("device.savePromptMessage", { name: device?.name || t("device.addTitle") })}</p>
      <div className="dialog-actions">
        <button type="button" disabled={busy} autoFocus onClick={() => setPending(null)}>{t("device.keepEditing")}</button>
        <button type="button" disabled={busy} onClick={() => { const action = pending; setPending(null); action?.(); }}>{t("unsaved.discard")}</button>
        <button type="button" className="primary" disabled={busy} onClick={() => { const action = pending; void save().then((saved) => { setPending(null); if (saved) action?.(); }); }}>{t("device.saveAndContinue")}</button>
      </div>
    </dialog>
  </>;
}
