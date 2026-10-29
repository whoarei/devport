import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "devport-tests-"));
const entries = ["store", "editorTabs", "editorLanguages", "shortcuts", "layout", "review", "workspace", "workspaceLaunch", "workspaceRun", "runHistory", "remoteWorkspace", "deviceWorkspace", "deviceEditor", "appUpdate", "storageMigration", "release", "terminal", "terminalCopyOnSelect", "terminalClipboard", "ipcContract", "presetCommands", "device", "eventStore", "uiZoom", "theme", "environment", "usb", "fileTransfer", "workspaceTransfers"];
try {
  await build({
    entryPoints: entries.map((name) => `tests/${name}.test.ts`),
    outdir: directory,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const result = spawnSync(process.execPath, ["--test", ...entries.map((name) => join(directory, `${name}.test.cjs`))], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
