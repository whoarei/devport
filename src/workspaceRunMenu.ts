import { api, type CommandSource, type WorkspaceCommand, type WorkspaceCommandRecord, type WorkspaceEntry, type WorkspaceRef } from "./api";
import { useWorkspaceRunStore, workspaceSourceCurrent } from "./workspaceRunStore";
import { commandLabel, commandsFor, inferModule } from "./workspaceRun";
import type { MenuEntry } from "./components/ContextMenu";
import i18n from "./i18n";
import { appCommandEnabled, executeAppCommand } from "./appCommands";
import { shortcutLabel } from "./shortcuts";

export async function missingCommandIds(workspace:WorkspaceRef,records:WorkspaceCommandRecord[]):Promise<Set<string>> {
  const directories=new Map<string,Promise<WorkspaceEntry[]>>();
  const missing=new Set<string>();
  await Promise.all(records.map(async (r)=>{
    if(r.entry.type==="python_module") return;
    const path=r.entry.path, slash=path.lastIndexOf("/"), dir=slash<0?"":path.slice(0,slash), name=path.slice(slash+1);
    let load=directories.get(dir);if(!load) {load=api.listWorkspaceDir(workspace,dir).catch(()=>[]);directories.set(dir,load);}
    if(!(await load).some((e)=>!e.is_dir&&e.name===name)) missing.add(r.id);
  }));
  return missing;
}

export async function workspaceRunMenu(workspace: WorkspaceRef, path: string, directory: boolean): Promise<MenuEntry[]> {
  const t = (key: string) => i18n.t(`workspaceRun.${key}`);
  const state = useWorkspaceRunStore.getState(), source: CommandSource | undefined = path ? { type: directory ? "dir" : "file", path } : undefined;
  const current = () => workspaceSourceCurrent(workspace, state.sourceRevision);
  const run = (command: WorkspaceCommand) => { if (current()) state.run(command, source, workspace); };
  const history = () => { if (current()) useWorkspaceRunStore.setState({ history: { workspace, source } }); };
  const entries: MenuEntry[] = [];
  const module = inferModule(path, directory, state.config?.config.run_defaults.cwd ?? ".", state.info?.python_path ?? []);
  const edit = (command: WorkspaceCommand, asModule = false) => { if (current()) useWorkspaceRunStore.setState({ args: { workspace, command, source, module: asModule } }); };
  const recent = commandsFor(state.commands?.entries ?? [], source);
  const missing = await missingCommandIds(workspace,recent.slice(0,10));
  const seedArgs = (command: WorkspaceCommand) => recent.find((r) => JSON.stringify(r.entry) === JSON.stringify(command.entry))?.args ?? [];
  if (!directory && /\.(py|sh)$/i.test(path)) {
    const context = { area: "workspace" as const, filePath: path };
    entries.push({ label: i18n.t("run.run"), detail: shortcutLabel("runFile"), disabled: !appCommandEnabled("runFile", context),
      onSelect: () => { if (current()) void executeAppCommand("runFile", context); } },
    { label: t("withArgs"), detail: shortcutLabel("runWithArgs"), disabled: !appCommandEnabled("runWithArgs", context),
      onSelect: () => { if (current()) void executeAppCommand("runWithArgs", context); } });
    if (/\.py$/i.test(path)) entries.push({ label: t("asModule"), onSelect: () => edit({ entry: { type: "python_module", name: module ?? "" }, args: [] }, true) });
  } else if (!path) entries.push({ label: t("runModule"), onSelect: () => edit({ entry: { type: "python_module", name: "" }, args: [] }, true) });
  else if (directory) {
    const children = await api.listWorkspaceDir(workspace, path).catch(() => []);
    if (module && children.some((e) => e.name === "__main__.py" && !e.is_dir)) {
      const command: WorkspaceCommand = { entry: { type: "python_module", name: module }, args: [] };
      entries.push({ label: t("runPackage"), onSelect: () => run(command) }, { label: t("packageArgs"), onSelect: () => edit({ ...command, args: seedArgs(command) }, true) });
    }
  }
  if (!path || directory || /\.(py|sh)$/i.test(path)) entries.push({ label: t("history"), children: [
    ...(recent.length ? recent.slice(0, 10).map((r) => ({ label: `${r.needs_edit || missing.has(r.id) ? i18n.t("runnerEntry.needsEdit") + " · " : ""}${r.entry.type === "python_module" || !source ? commandLabel(r) + " " : ""}${r.args.length ? JSON.stringify(r.args) : t("noArgs")}`, disabled: r.needs_edit || missing.has(r.id), onSelect: () => run(r) })) : [{ label: t("noHistory"), disabled: true }]),
    "separator", { label: t("manageHistory"), onSelect: history },
  ] });
  if (!path) entries.push({ label: t("settings"), onSelect: () => useWorkspaceRunStore.setState({ settingsOpen: true }) });
  return current() && entries.length ? [...entries, "separator"] : [];
}
