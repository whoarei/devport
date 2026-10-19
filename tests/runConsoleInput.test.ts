import test from "node:test";
import assert from "node:assert/strict";
import { handleRunConsoleKey } from "../src/runConsoleInput";

const ctrlC = { type: "keydown", ctrlKey: true, altKey: false, metaKey: false,
  shiftKey: false, key: "c", repeat: false };

test("Ctrl+C sends one interrupt and suppresses xterm's duplicate input and key repeat", () => {
  const sent: string[] = [], copied: string[] = [];
  const handle = (event: typeof ctrlC) => handleRunConsoleKey(event, "", (data) => sent.push(data), (text) => copied.push(text));
  assert.equal(handle(ctrlC), false);
  assert.equal(handle({ ...ctrlC, repeat: true }), false);
  assert.equal(handle({ ...ctrlC, type: "keyup" }), true);
  assert.deepEqual(sent, ["\x03"]);
  assert.deepEqual(copied, []);
  assert.equal(handle(ctrlC), false);
  assert.deepEqual(sent, ["\x03", "\x03"], "a separate key press sends another single interrupt");
});

test("Ctrl+C with a selection copies without interrupting; other keys stay with xterm", () => {
  const sent: string[] = [], copied: string[] = [];
  assert.equal(handleRunConsoleKey(ctrlC, "selected", (data) => sent.push(data), (text) => copied.push(text)), false);
  for (const event of [{ ...ctrlC, ctrlKey: false }, { ...ctrlC, key: "v" }, { ...ctrlC, shiftKey: true }]) {
    assert.equal(handleRunConsoleKey(event, "", (data) => sent.push(data), (text) => copied.push(text)), true);
  }
  assert.deepEqual(sent, []);
  assert.deepEqual(copied, ["selected"]);
});
