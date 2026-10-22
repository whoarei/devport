import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PRESET_COMMAND,
  MAX_PRESET_NAME,
  MAX_PRESETS,
  loadPresets,
  normalizePresets,
  savePresets,
} from "../src/presetCommands";

function mockLocalStorage(t: test.TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, String(value)); },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  return data;
}

test("normalizePresets returns empty for non-array input", () => {
  assert.deepEqual(normalizePresets(undefined), []);
  assert.deepEqual(normalizePresets(null), []);
  assert.deepEqual(normalizePresets("broken"), []);
  assert.deepEqual(normalizePresets(42), []);
  assert.deepEqual(normalizePresets({}), []);
});

test("normalizePresets drops entries without a command, allows empty names, and fills defaults", () => {
  const presets = normalizePresets([
    { id: "a", name: " cpu ", command: " cat /proc/cpuinfo " },
    { id: "b", name: "", command: "x" },
    { id: "c", name: "no command" },
    { id: "blank", name: "   ", command: "   " },
    "garbage",
    { id: "d", name: "mem", command: "free -h", consoleMode: "pipe", timeoutSecs: 30 },
    { id: "whitespace", name: "   ", command: " echo hello " },
    { id: "missing", command: "pwd" },
  ]);
  assert.equal(presets.length, 5);
  assert.deepEqual(presets[0], { id: "a", name: "cpu", command: "cat /proc/cpuinfo", consoleMode: "pty", timeoutSecs: 0 });
  assert.deepEqual(presets[1], { id: "b", name: "", command: "x", consoleMode: "pty", timeoutSecs: 0 });
  assert.deepEqual(presets[2], { id: "d", name: "mem", command: "free -h", consoleMode: "pipe", timeoutSecs: 30 });
  assert.deepEqual(presets[3], { id: "whitespace", name: "", command: "echo hello", consoleMode: "pty", timeoutSecs: 0 });
  assert.deepEqual(presets[4], { id: "missing", name: "", command: "pwd", consoleMode: "pty", timeoutSecs: 0 });
});

test("normalizePresets deduplicates ids, clamps values, and generates missing ids", () => {
  const presets = normalizePresets([
    { id: "dup", name: "one", command: "a", timeoutSecs: -5 },
    { id: "dup", name: "two", command: "b" },
    { name: "three", command: "c", timeoutSecs: 99999999 },
  ]);
  assert.equal(presets.length, 2);
  assert.equal(presets[0].timeoutSecs, 0);
  assert.equal(presets[1].name, "three");
  assert.ok(presets[1].id);
  assert.equal(presets[1].timeoutSecs, 86400);
});

test("normalizePresets truncates overlong fields and caps the total count", () => {
  const long = normalizePresets([{ id: "x", name: "n".repeat(200), command: "c".repeat(5000) }]);
  assert.equal(long[0].name.length, MAX_PRESET_NAME);
  assert.equal(long[0].command.length, MAX_PRESET_COMMAND);

  const many = normalizePresets(
    Array.from({ length: MAX_PRESETS + 20 }, (_, i) => ({ id: `p${i}`, name: `n${i}`, command: "true" })),
  );
  assert.equal(many.length, MAX_PRESETS);
});

test("loadPresets/savePresets round-trip and survive corrupted storage", (t) => {
  const data = mockLocalStorage(t);
  assert.deepEqual(loadPresets(), []);

  const presets = [
    { id: "a", name: "cpu", command: "cat /proc/cpuinfo", consoleMode: "pty" as const, timeoutSecs: 0 },
    { id: "b", name: "logs", command: "dmesg | tail", consoleMode: "pipe" as const, timeoutSecs: 10 },
    { id: "c", name: "", command: "echo hello\npwd", consoleMode: "pty" as const, timeoutSecs: 0 },
  ];
  savePresets(presets);
  assert.deepEqual(loadPresets(), presets);

  // 损坏的 JSON → 空列表
  data.set("remote-runner.presets.v1", "{not json");
  assert.deepEqual(loadPresets(), []);

  // 合法 JSON 但含无效条目 → 过滤
  data.set("remote-runner.presets.v1", JSON.stringify([{ id: "a", name: "x", command: "y" }, { name: "" }]));
  assert.equal(loadPresets().length, 1);
});
