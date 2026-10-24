import { api, errorMessage, type DeletedDevice, type DeviceProfile } from "./api";
import { useAppStore } from "./store";
import { useEventStore } from "./eventStore";
import i18n from "./i18n";

let operations: Promise<unknown> = Promise.resolve();
const deletedEventId = (id: string) => `device-deleted:${id}`;

function withDefault(devices: DeviceProfile[]): DeviceProfile[] {
  const id = devices.find((device) => device.is_default)?.id ?? devices[0]?.id;
  return devices.map((device) => ({ ...device, is_default: device.id === id }));
}

function serialize<T>(action: () => Promise<T>): Promise<T> {
  const result = operations.then(action);
  operations = result.catch(() => {});
  return result;
}

function reportError(key: "deleteFailed" | "refreshFailed" | "loadDeletedFailed", error: unknown) {
  useEventStore.getState().add({
    id: `device-error:${key}`,
    timestamp: Date.now(),
    title: () => i18n.t(`device.${key}`),
    message: errorMessage(error),
    level: "error",
  });
}

function addDeletedEvent(device: DeletedDevice) {
  useEventStore.getState().add({
    id: deletedEventId(device.id),
    timestamp: Date.parse(device.deleted_at),
    title: () => i18n.t("device.deleted", { name: device.name }),
    remove: () => serialize(() => api.purgeDeletedDevice(device.id, device.deleted_at)),
    action: { label: () => i18n.t("device.undoDelete"), run: () => restoreDeletedDevice(device.id) },
  });
}

async function refreshDevices() {
  try { await useAppStore.getState().loadDevices(); }
  catch (error) { reportError("refreshFailed", error); }
}

export function loadDeletedDeviceEvents(): Promise<void> {
  return serialize(async () => {
    try {
      const deleted = await api.listDeletedDevices();
      const ids = new Set(deleted.map((device) => deletedEventId(device.id)));
      for (const event of useEventStore.getState().events) {
        if (event.id.startsWith("device-deleted:") && !ids.has(event.id)) useEventStore.getState().dismiss(event.id);
      }
      // Preserve retry errors and identities used by in-flight event operations.
      for (const device of deleted) {
        const existing = useEventStore.getState().events.find((event) => event.id === deletedEventId(device.id));
        if (!existing || existing.timestamp !== Date.parse(device.deleted_at)) addDeletedEvent(device);
      }
    } catch (error) { reportError("loadDeletedFailed", error); }
  });
}

export function deleteDevice(device: Pick<DeviceProfile, "id">): Promise<boolean> {
  return serialize(async () => {
    try {
      const deleted = await api.deleteDevice(device.id);
      addDeletedEvent(deleted);
      const state = useAppStore.getState();
      state.setDevices(withDefault(state.devices.filter((item) => item.id !== device.id)));
      await refreshDevices();
      return true;
    } catch (error) {
      reportError("deleteFailed", error);
      return false;
    }
  });
}

export function restoreDeletedDevice(id: string): Promise<void> {
  return serialize(async () => {
    const restored = await api.restoreDevice(id);
    const state = useAppStore.getState();
    state.setDevices(withDefault([...state.devices.filter((device) => device.id !== id), restored]));
    await refreshDevices();
  });
}

export function saveDevice(device: DeviceProfile): Promise<DeviceProfile> {
  return serialize(async () => {
    const saved = await api.saveDevice(device);
    const state = useAppStore.getState();
    let devices = state.devices.some((item) => item.id === saved.id)
      ? state.devices.map((item) => item.id === saved.id ? saved : item)
      : [...state.devices, saved];
    if (saved.is_default) devices = devices.map((item) => ({ ...item, is_default: item.id === saved.id }));
    state.setDevices(withDefault(devices));
    await refreshDevices();
    return useAppStore.getState().devices.find((item) => item.id === saved.id) ?? saved;
  });
}

export function reorderDevices(ids: string[]): Promise<void> {
  return serialize(async () => {
    try {
      const devices = await api.reorderDevices(ids);
      useAppStore.getState().setDevices(devices);
    } catch (error) {
      await refreshDevices();
      throw error;
    }
  });
}
