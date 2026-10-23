// Manual browser fixture: device APIs are in-memory mocks; no devices are contacted.
// npm run dev -> /tests/device-browser.html. Not included in production builds.
import React from "react";
import { createRoot } from "react-dom/client";
import { emptyDevice } from "../src/components/DeviceEditor";
import { DeviceManager } from "../src/components/DeviceManager";
import { api, DeviceProfile } from "../src/api";
import { MenuBar } from "../src/components/MenuBar";
import { EventCenter } from "../src/components/EventCenter";
import { loadDeletedDeviceEvents } from "../src/deviceActions";
import { useEventStore } from "../src/eventStore";
import { useAppStore } from "../src/store";
import i18n from "../src/i18n";
import { initializeTheme } from "../src/theme";
import "../src/styles.css";
import "../src/theme.css";

void i18n.changeLanguage("zh");
initializeTheme();
const devices: DeviceProfile[] = [
  { ...emptyDevice(), id: "existing", name: "开发服务器", host: "10.0.0.1", is_default: true },
  { ...emptyDevice(), id: "wsl", name: "Ubuntu 开发环境", transport: "wsl", wsl: { distribution: "Ubuntu-24.04", user: "" } },
  { ...emptyDevice(), id: "local", name: "本机 PowerShell", transport: "local", local: { shell: "pwsh", path: null, no_profile: false } },
  { ...emptyDevice(), id: "board", name: "树莓派实验板", host: "10.0.0.2", username: "pi" },
  { ...emptyDevice(), id: "serial", name: "串口调试设备", transport: "serial", serial: { port: "COM8", baud_rate: 115200 } },
];
const deleted = new Map<string, { device: DeviceProfile; deleted_at: string }>();
let nextDeviceId = 1;
const fixture = { failReorder: false, failSave: false, reorderDelay: 0, reorderCalls: 0, snapshot: () => structuredClone(devices) };
Object.assign(window, { deviceFixture: fixture });
api.listDevices = async () => devices.map((device) => ({ ...device }));
api.reorderDevices = async (ids) => {
  fixture.reorderCalls++;
  if (fixture.reorderDelay) await new Promise((resolve) => setTimeout(resolve, fixture.reorderDelay));
  if (fixture.failReorder) { fixture.failReorder = false; throw new Error("模拟写入失败"); }
  if (new Set(ids).size !== devices.length || ids.length !== devices.length || ids.some((id) => !devices.some((d) => d.id === id))) throw new Error("设备列表已变化");
  devices.splice(0, devices.length, ...ids.map((id) => devices.find((device) => device.id === id)!));
  return devices.map((device) => ({ ...device }));
};
api.listSerialPorts = async () => ["COM8", "/dev/ttyUSB0"];
api.listWslDistributions = async () => ["Ubuntu-24.04"];
api.listLocalShells = async () => [{ id: "pwsh", label: "PowerShell", path: "C:/tools/pwsh.exe" }];
api.testDevice = async (device) => `测试连接名称：${device.name}`;
api.deleteDevice = async (id) => {
  const index = devices.findIndex((device) => device.id === id);
  if (index < 0) throw new Error("设备不存在");
  const [device] = devices.splice(index, 1);
  if (device.is_default && devices.length) devices[0] = { ...devices[0], is_default: true };
  const deleted_at = new Date().toISOString();
  deleted.set(id, { device, deleted_at });
  return { id, name: device.name, deleted_at };
};
api.listDeletedDevices = async () => [...deleted.values()].map(({ device, deleted_at }) => ({ id: device.id, name: device.name, deleted_at }));
api.restoreDevice = async (id) => {
  const entry = deleted.get(id);
  if (!entry) throw new Error("设备不存在");
  const restored = { ...entry.device, is_default: devices.length === 0 };
  devices.push(restored);
  deleted.delete(id);
  return restored;
};
api.saveDevice = async (device) => {
  if (fixture.failSave) { fixture.failSave = false; throw new Error("模拟保存失败"); }
  if (!device.name.trim() || (device.transport === "ssh" && !device.host.trim())) throw new Error("连接信息不完整");
  const saved = { ...device, id: device.id || `new-${nextDeviceId++}` };
  if (saved.is_default) devices.forEach((item) => { item.is_default = false; });
  const index = devices.findIndex((item) => item.id === saved.id);
  if (index < 0) devices.push(saved);
  else devices[index] = saved;
  return saved;
};
useAppStore.setState({ devices: [...devices], selectedDeviceId: "existing" });

function Fixture() {
  const savedDevices = useAppStore((state) => state.devices);
  return <><header className="titlebar" style={{ justifyContent: "space-between" }}>
    <MenuBar uiZoom={100} onUiZoom={() => {}} onAbout={() => {}} onCheckUpdate={() => {}} />
    <div className="titlebar-controls"><EventCenter /></div>
  </header><main style={{ padding: 24 }}>
    <p>设备配置交互验收（模拟接口，不连接设备）</p>
    <button onClick={() => useAppStore.getState().openDeviceManager()}>管理设备</button>
    <button onClick={() => { void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh"); }}>切换语言</button>
    <button onClick={() => { void loadDeletedDeviceEvents(); }}>重新读取删除记录</button>
    <button onClick={() => useEventStore.getState().add({ id: "example", timestamp: Date.now(), title: "普通事件示例", message: "通用事件也可以只显示消息。" })}>模拟普通事件</button>
    <ul>{savedDevices.map((device) => <li key={device.id}><button
      onClick={() => { useAppStore.getState().selectDevice(device.id); useAppStore.getState().openDeviceManager(); }}>管理 {device.name}</button></li>)}</ul>
    <DeviceManager />
  </main></>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
