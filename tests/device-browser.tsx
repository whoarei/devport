// Manual browser fixture: device APIs are in-memory mocks; no devices are contacted.
// npm run dev -> /tests/device-browser.html. Not included in production builds.
import React from "react";
import { createRoot } from "react-dom/client";
import { DeviceDialog, emptyDevice } from "../src/components/DeviceDialog";
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
const devices: DeviceProfile[] = [{ ...emptyDevice(), id: "existing", name: "开发服务器", host: "10.0.0.1" }];
const deleted = new Map<string, { device: DeviceProfile; deleted_at: string }>();
let nextDeviceId = 1;
api.listDevices = async () => devices.map((device) => ({ ...device }));
api.listSerialPorts = async () => ["COM8", "/dev/ttyUSB0"];
api.listWslDistributions = async () => ["Ubuntu-24.04"];
api.listLocalShells = async () => [{ id: "pwsh", label: "PowerShell", path: "C:/tools/pwsh.exe" }];
api.testDevice = async (device) => `测试连接名称：${device.name}`;
api.deleteDevice = async (id) => {
  const index = devices.findIndex((device) => device.id === id);
  if (index < 0) throw new Error("设备不存在");
  const [device] = devices.splice(index, 1);
  const deleted_at = new Date().toISOString();
  deleted.set(id, { device, deleted_at });
  return { id, name: device.name, deleted_at };
};
api.listDeletedDevices = async () => [...deleted.values()].map(({ device, deleted_at }) => ({ id: device.id, name: device.name, deleted_at }));
api.restoreDevice = async (id) => {
  const entry = deleted.get(id);
  if (!entry) throw new Error("设备不存在");
  devices.push(entry.device);
  deleted.delete(id);
  return entry.device;
};
api.saveDevice = async (device) => {
  const saved = { ...device, id: device.id || `new-${nextDeviceId++}` };
  const index = devices.findIndex((item) => item.id === saved.id);
  if (index < 0) devices.push(saved);
  else devices[index] = saved;
  return saved;
};
useAppStore.setState({ devices });

function Fixture() {
  const savedDevices = useAppStore((state) => state.devices);
  return <><header className="titlebar" style={{ justifyContent: "space-between" }}>
    <MenuBar uiZoom={100} onUiZoom={() => {}} onAbout={() => {}} onCheckUpdate={() => {}} />
    <div className="titlebar-controls"><EventCenter /></div>
  </header><main style={{ padding: 24 }}>
    <p>设备配置交互验收（模拟接口，不连接设备）</p>
    {(["ssh", "serial", "wsl", "local"] as const).map((transport) => <button key={transport}
      onClick={() => useAppStore.getState().openDeviceDialog({ ...emptyDevice(), transport })}>新增 {transport}</button>)}
    <button onClick={() => { void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh"); }}>切换语言</button>
    <button onClick={() => { void loadDeletedDeviceEvents(); }}>重新读取删除记录</button>
    <button onClick={() => useEventStore.getState().add({ id: "example", timestamp: Date.now(), title: "普通事件示例", message: "通用事件也可以只显示消息。" })}>模拟普通事件</button>
    <ul>{savedDevices.map((device) => <li key={device.id}><button
      onClick={() => useAppStore.getState().openDeviceDialog({ ...device })}>编辑 {device.name}</button></li>)}</ul>
    <DeviceDialog />
  </main></>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
