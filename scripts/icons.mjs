import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url));
const baseArgs = ["icon", "app-icon.png", "--output", "src-tauri/icons"];

// Keep platform bundles and the UI's exact-size assets on the same master.
for (const args of [
  [...baseArgs, "--ios-color", "#0c1a2d"],
  [...baseArgs, ...[16, 18, 24, 36, 48, 54, 64].flatMap((size) => ["--png", String(size)])],
]) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
