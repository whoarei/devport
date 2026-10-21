import { invoke } from "@tauri-apps/api/core";
import type { WorkEnvironment } from "./environmentState";

export type AuthMethod =
  | { type: "password"; password: string }
  | { type: "key"; key_path: string | null };

export interface DeviceProfile {
  revision?: string;
  id: string;
  name: string;
  is_default: boolean;
  transport: "ssh" | "serial" | "wsl" | "local";
  serial?: { port: string; baud_rate: number } | null;
  wsl?: { distribution: string; user: string } | null;
  local?: { shell: string; path?: string | null; no_profile?: boolean } | null;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  workspace_root: string;
}

/** 后端探测到的可用本机 shell */
export interface LocalShellInfo {
  id: string;
  label: string;
  path: string;
}

export interface UsbError { code: string; message: string }
export interface UsbDevice {
  instance_id: string;
  description: string;
  bus_id: string | null;
  persisted_guid: string | null;
  client_ip_address: string | null;
  is_forced: boolean;
}
export type UsbSelector = Pick<UsbDevice, "instance_id" | "bus_id" | "persisted_guid">;
export interface UsbSnapshot {
  supported: boolean;
  executable: string | null;
  version: string | null;
  problem: UsbError | null;
  wsl_problem: UsbError | null;
  distributions: { name: string; version: number }[];
  devices: UsbDevice[];
}
export interface UsbVerification { visible: boolean; accessible: boolean; nodes: string[] }
export interface UsbWslConfig { distribution: string; user: string }
export interface UsbRemoteConfig { device_id: string; host_ip: string }
export interface UsbRemoteProbe {
  host_ip: string;
  kernel: string;
  usbip_path: string | null;
  vhci_loaded: boolean;
  can_load_module: boolean;
  privilege: "root" | "sudo" | "unavailable";
  reachable: boolean;
  network_error: string | null;
  exports: { bus_id: string; vid: string; pid: string }[];
}

export type ScriptKind = "python" | "shell" | "command";
export type ConsoleMode = "pty" | "pipe";

/** 工作区来源（00004-workspace-and-sync.md）：本机目录，或某台设备上的目录（SSH 走 SFTP / WSL 走 helper 文件服务） */
export type WorkspaceRef =
  | { type: "local"; dir: string }
  | { type: "device"; device_id: string; path: string };

export const localWorkspace = (dir: string): WorkspaceRef => ({ type: "local", dir });
export const deviceWorkspace = (deviceId: string, path: string): WorkspaceRef => ({
  type: "device",
  device_id: deviceId,
  path,
});

export function workspaceRefEquals(a: WorkspaceRef | null | undefined, b: WorkspaceRef | null | undefined): boolean {
  if (!a || !b) return a === b || (!a && !b);
  if (a.type !== b.type) return false;
  return a.type === "local"
    ? a.dir === (b as { dir: string }).dir
    : a.type === "device" &&
        a.device_id === (b as { device_id: string }).device_id &&
        a.path === (b as { path: string }).path;
}

/** 设备工作区能否作为远端宿主（串口没有文件操作通道） */
export function isRemoteWorkspaceHost(device: DeviceProfile): boolean {
  return device.transport === "ssh" || device.transport === "wsl";
}

export interface RunRequest {
  device_id: string;
  workspace?: WorkspaceRef | null;
  kind: ScriptKind;
  entry?: string | null;
  args?: string[];
  env?: Record<string, string>;
  command?: string | null;
  /** Managed Python Runtime（uv-only 项目模型）；仅 python 脚本可用 */
  managed_python?: boolean;
  console_mode?: ConsoleMode;
  cols?: number;
  rows?: number;
  timeout_secs?: number;
}

export interface RunStatus {
  run_id: string;
  device_name: string;
  label: string;
  state: string; // preparing | syncing | starting | running | stopping | exited | failed | canceled
  exit_code: number | null;
  error: string | null;
  started_at: string;
  ended_at: string | null;
  /** 已持久化的输出字节数；0 表示没有可导出的输出（旧历史条目缺省 0） */
  output_bytes?: number;
  /** 输出超过单 run 日志上限被截断 */
  output_truncated?: boolean;
  /** Managed Runtime 准备阶段（validating_project 等）；无准备时缺省 */
  phase?: string;
  /** 运行可追溯信息：环境 / uv / Python / lock */
  environment_id?: string;
  uv_version?: string;
  python_version?: string;
  lock_sha256?: string;
  waiting_workspace?: boolean;
  workspace_sync?: {
    destination: string; added: number; updated: number; deleted: number;
    skipped: number; permissions: number; uploaded_bytes: number;
  };
}

export interface TerminalStatus {
  session_id: string;
  device_name: string;
  state: "connecting" | "connected" | "closing" | "exited" | "failed" | "closed";
  exit_code: number | null;
  error: string | null;
}

export interface TerminalRead { status: TerminalStatus; data: string }

export type RunEvent =
  | { type: "launch"; run_id: string; launch: WorkspaceLaunch }
  | { type: "workspace_state"; run_id: string; workspace: WorkspaceRef; warning: string | null }
  | { type: "output"; run_id: string; stream: string; data: string }
  | { type: "status"; status: RunStatus }
  | { type: "resync"; statuses: RunStatus[] }
  | {
      type: "runtime_progress";
      run_id: string;
      phase: string;
      message: string;
      downloaded_bytes: number;
      total_bytes: number | null;
    };

// ---------- Managed Python Runtime（uv-only） ----------

export type WorkspaceRunEntry =
  | { type: "python_script" | "bash_script"; path: string }
  | { type: "python_module"; name: string };
export interface WorkspaceCommand { entry: WorkspaceRunEntry; args: string[] }
export interface CommandSource { type: "file" | "dir"; path: string }
export interface WorkspaceCommandRecord extends WorkspaceCommand { id: string; sources?: CommandSource[]; last_used_at: string; needs_edit?: boolean }
export interface WorkspaceCommands { entries: WorkspaceCommandRecord[]; revision: string }
export interface RunnerConfig { schema: 1; run_defaults: { cwd: string } }
export interface RunnerConfigState { config: RunnerConfig; revision: string }
export type PythonSelection = "device_default" | "project";
export interface WorkspaceExecutionSettings {
  cwd: string; env: Record<string,string>; console_mode: ConsoleMode; timeout_secs: number;
  cols: number; rows: number; bash?: string | null;
}
export interface WorkspaceRunRequest {
  config_revision?: string | null;
  workspace: WorkspaceRef; device_id: string; device_revision: string;
  command: WorkspaceCommand; python: PythonSelection; settings: WorkspaceExecutionSettings;
  source?: CommandSource | null; operation?: "run" | "prepare" | "rebuild";
}
export interface WorkspaceLaunch { program: string; version: string | null; cwd: string; python_path: string[]; environment: "device_default" | "project" | "bash" | "command" }
export interface WorkspaceRunSession { request: WorkspaceRunRequest | null; launch: WorkspaceLaunch | null; warning: string | null }
export interface WorkspacePythonInfo { python_version: string | null; python_path: string[]; project: PythonProject | null; legacy_entry: string | null; legacy_module: boolean }
export interface PythonProbe { program: string; version: string; env: Record<string,string> }

export interface PythonProject {
  name: string;
  requires_python: string;
  python_version: string;
  lock_sha256: string;
  entry: string;
  mode: "script" | "module";
  python_path: string[];
  groups: string[];
  extras: string[];
  package_source_identity: string;
}

export interface ManagedRuntimeInfo {
  uv_version: string;
  platform: string;
  uv_path: string;
  present: boolean;
}

export interface EnvironmentManifest {
  schema: number;
  environment_id: string;
  uv_version: string;
  python_request: string;
  python_executable: string;
  python_version: string;
  python_build: string;
  platform: string;
  libc: string | null;
  lock_sha256: string;
  groups: string[];
  extras: string[];
  created_at: string;
  last_used_at: string;
}

export interface ProjectEnvironmentInfo {
  id: string;
  path: string;
  ready: boolean;
  leased: boolean;
  manifest: EnvironmentManifest | null;
}

export interface NetworkConfig {
  mode: "direct" | "mirror" | "offline";
  python_install_mirror?: string | null;
  index_url?: string | null;
}

/** 重建完成后的可直接启动环境 */
export interface PreparedEnvironment {
  environment_id: string;
  env_path: string;
  python_path: string;
  uv_version: string;
  python_version: string;
  lock_sha256: string;
  cache_hit: boolean;
}

export interface WorkspaceEntry {
  name: string;
  is_dir: boolean;
}

export type WorkspaceEntryKind = "file" | "dir";

export interface WorkspaceDocument {
  content: string;
  revision: string;
  eol: "lf" | "crlf";
  bom: boolean;
}

export interface SaveWorkspaceRequest {
  workspace: WorkspaceRef;
  name: string;
  content: string;
  expectedRevision: string;
  eol: "lf" | "crlf";
  bom: boolean;
}

export interface AppUpdateInfo {
  current_version: string;
  latest_version: string;
  notes: string | null;
  published_at: string | null;
  download_url: string;
  /** false 表示 portable 形态，只能回退到手动下载（方案 B） */
  can_auto_install: boolean;
}

export function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message);
  return String(error);
}

export const api = {
  readWorkEnvironment: () => invoke<WorkEnvironment | null>("read_work_environment"),
  saveWorkEnvironment: (snapshot: WorkEnvironment) => invoke<void>("save_work_environment", { snapshot }),
  readRunnerConfig: (workspace: WorkspaceRef) => invoke<RunnerConfigState>("read_runner_config", { workspace }),
  saveRunnerConfig: (workspace: WorkspaceRef, config: RunnerConfig, expectedRevision: string) => invoke<RunnerConfigState>("save_runner_config", { workspace, config, expectedRevision }),
  listWorkspaceCommands: (workspace: WorkspaceRef) => invoke<WorkspaceCommands>("list_workspace_commands", { workspace }),
  deleteWorkspaceCommand: (workspace: WorkspaceRef, id: string, expectedRevision: string) => invoke<WorkspaceCommands>("delete_workspace_command", { workspace, id, expectedRevision }),
  editWorkspaceCommandEntry: (workspace: WorkspaceRef, id: string, entry: WorkspaceRunEntry, expectedRevision: string) => invoke<WorkspaceCommands>("edit_workspace_command_entry", { workspace, id, entry, expectedRevision }),
  inspectWorkspacePython: (workspace: WorkspaceRef, project: boolean) => invoke<WorkspacePythonInfo>("inspect_workspace_python", { workspace, project }),
  probePythonEnvironment: (deviceId: string) => invoke<PythonProbe>("probe_python_environment", { deviceId }),
  runnerLockInfo: (workspace: WorkspaceRef) => invoke<{ content: string; revision: string } | null>("runner_lock_info", { workspace }),
  recoverRunnerLock: (workspace: WorkspaceRef, expectedRevision: string) => invoke<void>("recover_runner_lock", { workspace, expectedRevision }),
  runWorkspace: (request: WorkspaceRunRequest) => invoke<string>("run_workspace", { request }),
  getWorkspaceRun: (runId: string) => invoke<WorkspaceRunSession | null>("get_workspace_run", { runId }),
  retryWorkspaceHistory: (runId: string) => invoke<void>("retry_workspace_history", { runId }),
  renameWorkspaceCommands: (workspace: WorkspaceRef, oldPath: string, newPath: string) => invoke<WorkspaceCommands>("rename_workspace_commands", { workspace, oldPath, newPath }),
  openTerminal: (deviceId: string, cols = 80, rows = 24) => invoke<TerminalStatus>("open_terminal", { deviceId, cols, rows }),
  openWorkspaceTerminal: (deviceId: string, workspace: WorkspaceRef, subdir: string, cols = 80, rows = 24) =>
    invoke<TerminalStatus>("open_workspace_terminal", { deviceId, workspace, subdir, cols, rows }),
  readTerminal: (sessionId: string) => invoke<TerminalRead>("read_terminal", { sessionId }),
  sendTerminalInput: (sessionId: string, data: string) => invoke<void>("send_terminal_input", { sessionId, data }),
  resizeTerminal: (sessionId: string, cols: number, rows: number) => invoke<void>("resize_terminal", { sessionId, cols, rows }),
  closeTerminal: (sessionId: string) => invoke<void>("close_terminal", { sessionId }),
  closeAllTerminals: () => invoke<void>("close_all_terminals"),
  listDevices: () => invoke<DeviceProfile[]>("list_devices"),
  saveDevice: (device: DeviceProfile) =>
    invoke<DeviceProfile>("save_device", { device }),
  deleteDevice: (id: string) => invoke<void>("delete_device", { id }),
  testDevice: (device: DeviceProfile) =>
    invoke<string>("test_device", { device }),
  listSerialPorts: () => invoke<string[]>("list_serial_ports"),
  listWslDistributions: () => invoke<string[]>("list_wsl_distributions"),
  usbSnapshot: () => invoke<UsbSnapshot>("usb_snapshot"),
  usbConnect: (selector: UsbSelector, config: UsbWslConfig) => invoke<void>("usb_connect", { selector, config }),
  usbDisconnect: (selector: UsbSelector) => invoke<void>("usb_disconnect", { selector }),
  usbUnshare: (selector: UsbSelector) => invoke<void>("usb_unshare", { selector }),
  usbVerify: (selector: UsbSelector, config: UsbWslConfig) => invoke<UsbVerification>("usb_verify", { selector, config }),
  usbRemoteProbe: (config: UsbRemoteConfig) => invoke<UsbRemoteProbe>("usb_remote_probe", { config }),
  usbRemoteConnect: (selector: UsbSelector, config: UsbRemoteConfig) => invoke<string>("usb_remote_connect", { selector, config }),
  usbRemoteDisconnect: (selector: UsbSelector, config: UsbRemoteConfig) => invoke<void>("usb_remote_disconnect", { selector, config }),
  usbRemoteVerify: (selector: UsbSelector, config: UsbRemoteConfig) => invoke<UsbVerification>("usb_remote_verify", { selector, config }),
  listLocalShells: () => invoke<LocalShellInfo[]>("list_local_shells"),

  listWorkspaceDir: (workspace: WorkspaceRef, subdir: string) =>
    invoke<WorkspaceEntry[]>("list_workspace_dir", { workspace, subdir }),
  openWorkspaceInFileManager: (workspace: WorkspaceRef, subdir = "") =>
    invoke<void>("open_workspace_in_file_manager", { workspace, subdir }),
  readWorkspaceFile: (workspace: WorkspaceRef, name: string) =>
    invoke<WorkspaceDocument>("read_workspace_file", { workspace, name }),
  writeWorkspaceFile: (request: SaveWorkspaceRequest) =>
    invoke<{ revision: string }>("write_workspace_file", { request }),
  createWorkspaceEntry: (workspace: WorkspaceRef, name: string, kind: WorkspaceEntryKind) =>
    invoke<void>("create_workspace_entry", { workspace, name, kind }),
  renameWorkspaceEntry: (workspace: WorkspaceRef, oldName: string, newName: string) =>
    invoke<void>("rename_workspace_entry", { workspace, oldName, newName }),
  deleteWorkspaceEntry: (workspace: WorkspaceRef, name: string) =>
    invoke<void>("delete_workspace_entry", { workspace, name }),
  generateWorkspaceConfig: (workspace: WorkspaceRef) =>
    invoke<void>("generate_workspace_config", { workspace }),
  /** 关闭远端工作区编辑会话（关闭或切换工作区时调用；本机工作区为 no-op） */
  closeWorkspaceSession: () => invoke<void>("close_workspace_session"),

  runScript: (request: RunRequest) => invoke<string>("run_script", { request }),
  stopRun: (runId: string) => invoke<void>("stop_run", { runId }),
  sendRunInput: (runId: string, data: string) =>
    invoke<void>("send_run_input", { runId, data }),
  resizeRunConsole: (runId: string, cols: number, rows: number) =>
    invoke<void>("resize_run_console", { runId, cols, rows }),
  getRunStatus: (runId: string) =>
    invoke<RunStatus | null>("get_run_status", { runId }),
  listRunningRuns: () => invoke<RunStatus[]>("list_running_runs"),
  getRunHistory: () => invoke<RunStatus[]>("get_run_history"),
  drainRunEvents: () => invoke<RunEvent[]>("drain_run_events"),

  inspectPythonProject: (workspaceDir: string) =>
    invoke<PythonProject>("inspect_python_project", { workspaceDir }),
  listManagedRuntimes: (deviceId: string) =>
    invoke<ManagedRuntimeInfo>("list_managed_runtimes", { deviceId }),
  listProjectEnvironments: (deviceId: string) =>
    invoke<ProjectEnvironmentInfo[]>("list_project_environments", { deviceId }),
  rebuildProjectEnvironment: (deviceId: string, workspaceDir: string, network?: NetworkConfig) =>
    invoke<PreparedEnvironment>("rebuild_project_environment", { deviceId, workspaceDir, network: network ?? null }),
  deleteProjectEnvironment: (deviceId: string, environmentId: string) =>
    invoke<void>("delete_project_environment", { deviceId, environmentId }),
  cleanRuntimeCache: (deviceId: string) =>
    invoke<number>("clean_runtime_cache", { deviceId }),

  checkAppUpdate: () => invoke<AppUpdateInfo | null>("check_app_update"),
  installAppUpdate: (expectedVersion: string) => invoke<void>("install_app_update", { expectedVersion }),
};

// One bounded IPC response at a time: a slow/hidden WebView cannot accumulate
// unbounded native event deliveries. StrictMode cleanup waits for an in-flight
// response to be consumed before the next subscriber starts draining.
let drainInFlight: Promise<void> = Promise.resolve();
export function onRunEvents(cb: (events: RunEvent[]) => void, onError: (error: unknown) => void) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = () => {
    drainInFlight = drainInFlight.then(async () => {
      if (disposed) return;
      try { cb(await api.drainRunEvents()); }
      catch (error) { if (!disposed) onError(error); }
    }).finally(() => {
      if (!disposed) timer = setTimeout(poll, 33);
    });
  };
  poll();
  return () => { disposed = true; clearTimeout(timer); };
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 根据入口文件推断脚本类型 */
export function inferKind(entry: string): ScriptKind {
  const lower = entry.toLowerCase();
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".sh")) return "shell";
  return "command";
}
