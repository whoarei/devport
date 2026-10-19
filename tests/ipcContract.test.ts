import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// 前端 invoke 的载荷键必须与 Rust 命令的参数名一致（camelCase ↔ snake_case）。
// 只对不上的后果是运行期的 “invalid args … missing required key”，报错只提命令名和键名，
// 前端 / 后端各自的测试都覆盖不到，所以这里直接对两侧源码做契约检查。
const api = readFileSync(resolve("src/api.ts"), "utf8") + "\n" + readFileSync(resolve("src/transferApi.ts"), "utf8");
const commands = rustSources(resolve("src-tauri/src"));

/** 递归读取后端源码：命令分散在 commands.rs 与 update.rs 等模块里 */
function rustSources(dir: string): string {
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => entry.isDirectory()
      ? rustSources(join(dir, entry.name))
      : entry.name.endsWith(".rs") ? readFileSync(join(dir, entry.name), "utf8") : "")
    .join("\n");
}

/** Tauri 自己注入的参数：不出现在 IPC 载荷里 */
const INJECTED = /State<|AppHandle|Window|ipc::Channel/;

const camel = (name: string) => name.replace(/_+([a-z0-9])/g, (_, char: string) => char.toUpperCase());

/** 按顶层逗号切分参数列表 / 对象字面量（忽略泛型与嵌套括号里的逗号） */
function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of source) {
    if (char === "<" || char === "(" || char === "[") depth += 1;
    if (char === ">" || char === ")" || char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** commands.rs 中某命令的 IPC 参数（键名为 camelCase，与 macro 的默认 rename_all 一致） */
function rustParams(name: string): Array<{ key: string; optional: boolean }> {
  const head = new RegExp(`fn\\s+${name}\\s*\\(`).exec(commands);
  assert.ok(head, `commands.rs 里没有命令 ${name}`);
  const open = head.index + head[0].length;
  let depth = 0;
  let end = -1;
  for (let index = open; index < commands.length; index += 1) {
    const char = commands[index];
    if (char === ")" ) {
      if (depth === 0) { end = index; break; }
      depth -= 1;
    } else if (char === "<" || char === "(" || char === "[") depth += 1;
    else if (char === ">" || char === "]") depth -= 1;
  }
  assert.ok(end >= open, `命令 ${name} 的参数列表没有闭合`);

  const params: Array<{ key: string; optional: boolean }> = [];
  for (const raw of splitTopLevel(commands.slice(open, end))) {
    const text = raw.replace(/\/\/[^\n]*/g, "").trim();
    if (!text) continue;
    const colon = text.indexOf(":");
    assert.ok(colon > 0, `无法解析 ${name} 的参数 “${text}”`);
    const type = text.slice(colon + 1).trim();
    if (INJECTED.test(type)) continue;
    params.push({ key: camel(text.slice(0, colon).trim().replace(/^mut\s+/, "")), optional: type.startsWith("Option<") });
  }
  return params;
}

/** api.ts 中每个 invoke 调用的命令名与载荷键 */
function invokeCalls(): Array<{ command: string; keys: string[] }> {
  const calls: Array<{ command: string; keys: string[] }> = [];
  const pattern = /invoke(?:<[^(]*?>)?\(\s*"([a-z0-9_]+)"\s*(?:,\s*\{([^{}]*)\})?\s*\)/g;
  for (const match of api.matchAll(pattern)) {
    const keys = splitTopLevel(match[2] ?? "")
      .map((entry) => entry.split(":")[0].trim())
      .filter(Boolean);
    calls.push({ command: match[1], keys });
  }
  return calls;
}

test("every invoke payload matches its Rust command parameters", () => {
  const calls = invokeCalls();
  // 解析不到 = 载荷不是内联对象字面量；解析规则要跟着更新，否则这条契约形同虚设
  assert.equal(calls.length, (api.match(/invoke[(<]/g) ?? []).length, "有 invoke 调用没有被解析到");
  for (const { command, keys } of calls) {
    const params = rustParams(command);
    const declared = params.map((param) => param.key);
    assert.deepEqual(keys.filter((key) => !declared.includes(key)), [],
      `api.ts 给 ${command} 传了 Rust 不认识的参数`);
    assert.deepEqual(params.filter((param) => !param.optional && !keys.includes(param.key)).map((param) => param.key), [],
      `api.ts 漏传了 ${command} 的必填参数`);
  }
});

test("workspace terminals send the workspace source the command requires", () => {
  // 在终端中打开：Rust 要求 deviceId / workspace / subdir / cols / rows。
  // 前端曾按旧的 dir 参数传值（workspace 为 undefined 时 JSON 会丢掉该键），
  // 后端只会回 “missing required key workspace”。
  assert.deepEqual(rustParams("open_workspace_terminal").map((param) => param.key),
    ["deviceId", "workspace", "subdir", "cols", "rows"]);
  const call = invokeCalls().find((entry) => entry.command === "open_workspace_terminal");
  assert.deepEqual(call?.keys, ["deviceId", "workspace", "subdir", "cols", "rows"]);
});
