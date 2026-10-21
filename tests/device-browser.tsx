// Manual browser fixture: device APIs are in-memory mocks; no devices are contacted.
// npm run dev -> /tests/device-browser.html. Not included in production builds.
import React from "react";
import { createRoot } from "react-dom/client";
import { DeviceDialog, emptyDevice } from "../src/components/DeviceDialog";
import { api, DeviceProfile } from "../src/api";
import { useAppStore } from "../src/store";
import i18n from "../src/i18n";
import "../src/styles.css";

void i18n.changeLanguage("zh");
const devices: DeviceProfile[] = [{ ...emptyDevice(), id: "existing", name: "开发服务器", host: "10.0.0.1" }];
api.listDevices = async () => devices.map((device) => ({ ...device }));
api.listSerialPorts = async () => ["COM8", "/dev/ttyUSB0"];
api.listWslDistributions = async () => ["Ubuntu-24.04"];
api.listLocalShells = async () => [{ id: "pwsh", label: "PowerShell", path: "C:/tools/pwsh.exe" }];
api.testDevice = async (device) => `测试连接名称：${device.name}`;
api.saveDevice = async (device) => {
  const saved = { ...device, id: device.id || `new-${devices.length}` };
  const index = devices.findIndex((item) => item.id === saved.id);
  if (index < 0) devices.push(saved);
  else devices[index] = saved;
  return saved;
};
useAppStore.setState({ devices });

function Fixture() {
  const savedDevices = useAppStore((state) => state.devices);
  return <main style={{ padding: 24 }}>
    <p>设备配置交互验收（模拟接口，不连接设备）</p>
    {(["ssh", "serial", "wsl", "local"] as const).map((transport) => <button key={transport}
      onClick={() => useAppStore.getState().openDeviceDialog({ ...emptyDevice(), transport })}>新增 {transport}</button>)}
    <button onClick={() => { void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh"); }}>切换语言</button>
    <ul>{savedDevices.map((device) => <li key={device.id}><button
      onClick={() => useAppStore.getState().openDeviceDialog({ ...device })}>编辑 {device.name}</button></li>)}</ul>
    <DeviceDialog />
  </main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
