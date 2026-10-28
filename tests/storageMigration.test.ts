import assert from "node:assert/strict";
import test from "node:test";
import { migrateBrowserStorage } from "../src/storageMigration";

function storage(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  return { get length() { return entries.size; }, key: (i: number) => [...entries.keys()][i] ?? null,
    getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); }, clear: () => entries.clear() };
}

test("legacy preferences migrate once and work independently of their source keys", () => {
  const s = storage({ "remote-runner.language.v1": "en", "remote-runner.layout.v1": '{"panels":[]}', "other": "untouched" });
  migrateBrowserStorage(s);
  assert.equal(s.getItem("devport.language.v1"), "en");
  assert.equal(s.getItem("devport.layout.v1"), '{"panels":[]}');
  s.removeItem("remote-runner.language.v1");
  s.setItem("devport.language.v1", "zh");
  migrateBrowserStorage(s);
  assert.equal(s.getItem("devport.language.v1"), "zh");
  assert.equal(s.getItem("other"), "untouched");
});

test("existing values win and interrupted copies retain their originals for retry", () => {
  const s = storage({ "remote-runner.theme.v1": "dark", "remote-runner.language.v1": "en", "devport.theme.v1": "light" });
  const set = s.setItem;
  s.setItem = (key, value) => { if (key === "devport.language.v1") throw new Error("quota"); set(key, value); };
  assert.throws(() => migrateBrowserStorage(s));
  assert.equal(s.getItem("devport.storage-import.v1"), null);
  assert.equal(s.getItem("remote-runner.language.v1"), "en");
  s.setItem = set;
  migrateBrowserStorage(s);
  assert.equal(s.getItem("devport.theme.v1"), "light");
  assert.equal(s.getItem("devport.language.v1"), "en");
});
