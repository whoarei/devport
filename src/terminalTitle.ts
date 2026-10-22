import type { DeviceProfile } from "./api";
import type { TerminalTab } from "./terminalStore";

/** OSC 标题是自由文本；只压缩明确的程序路径和 user@host:目录，不据此推断 cwd。 */
export function terminalTabLabel(
  tab: Pick<TerminalTab, "title" | "deviceName">,
  device?: Pick<DeviceProfile, "name" | "transport">,
): string {
  const deviceName = device?.name.trim() || tab.deviceName;
  const title = tab.title?.trim();
  if (!title) return deviceName;
  const remote = device?.transport === "ssh" || device?.transport === "wsl";
  const withDevice = (label: string) => remote && label !== deviceName ? `${deviceName} · ${label}` : label;

  const location = /^[^@\s/:]+@(\[[^\]\s]+\]|[^:@\s/]+):(\/[^\r\n]*|~(?:\/[^\r\n]*)?)$/.exec(title);
  if (location) {
    const [, host, path] = location;
    const directory = path.replace(/\/+$/, "").split("/").pop() || "/";
    const identity = remote ? deviceName : host;
    return identity === directory ? identity : `${identity} · ${directory}`;
  }

  // 引号只参与识别，原始标题仍由 store 保留，供悬停和无障碍名称使用。
  const program = title.startsWith('"') && title.endsWith('"') ? title.slice(1, -1) : title;
  if (/^(?:[a-z]:[\\/]|\\\\)[^"\r\n:<>|?*]+\.exe$/i.test(program) && !/\.exe\s/i.test(program)) {
    const name = program.split(/[\\/]/).pop()!.replace(/\.exe$/i, "");
    if (name) return withDevice(name);
  }
  if (/^\/(?:[^/\s]+\/)*(?:bash|dash|zsh|fish|sh|pwsh)$/.test(program)) {
    return withDevice(program.split("/").pop()!);
  }
  return withDevice(title);
}
