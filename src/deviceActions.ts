import { api, errorMessage, type DeletedDevice, type DeviceProfile } from "./api";
import { useAppStore, selectedDeviceAfterLoad } from "./store";
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
    message: () => i18n.t("device.deletedHint"),
    dismissible: false,
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
      deleted.forEach(addDeletedEvent);
    } catch (error) { reportError("loadDeletedFailed", error); }
  });
}

export function deleteDevice(device: Pick<DeviceProfile, "id">): Promise<boolean> {
  return serialize(async () => {
    try {
      const deleted = await api.deleteDevice(device.id);
      addDeletedEvent(deleted);
      useAppStore.setState((state) => {
        const devices = withDefault(state.devices.filter((item) => item.id !== device.id));
        return {
          devices,
          selectedDeviceId: selectedDeviceAfterLoad(devices, state.selectedDeviceId),
          editingDevice: state.editingDevice?.id === device.id ? null : state.editingDevice,
        };
      });
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
    useAppStore.setState((state) => {
      const devices = withDefault([...state.devices.filter((device) => device.id !== id), restored]);
      return { devices, selectedDeviceId: selectedDeviceAfterLoad(devices, state.selectedDeviceId) };
    });
    await refreshDevices();
  });
}
