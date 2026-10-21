import type { DeviceProfile } from "./api";

/** 只用连接标识生成名称；关键字段未填写时保持为空。 */
export function automaticDeviceName(device: DeviceProfile): string {
  switch (device.transport) {
    case "ssh": {
      const host = device.host.trim();
      const user = device.username.trim();
      if (!host || !user || !device.port) return "";
      const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
      return `ssh-${user}@${address}:${device.port}`;
    }
    case "serial": {
      const port = device.serial?.port.trim();
      const baudRate = device.serial?.baud_rate;
      return port && baudRate ? `serial-${port}:${baudRate}` : "";
    }
    case "wsl": {
      const distribution = device.wsl?.distribution.trim();
      const user = device.wsl?.user.trim();
      return distribution ? `wsl-${user ? `${user}@` : ""}${distribution}` : "";
    }
    case "local": {
      const shell = device.local?.shell.trim();
      return shell ? `local-${shell}` : "";
    }
  }
}
