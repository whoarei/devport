import test from "node:test";
import assert from "node:assert/strict";
import { useEventStore } from "../src/eventStore";

function setup(t: test.TestContext) {
  const previous = useEventStore.getState();
  t.after(() => useEventStore.setState(previous, true));
  useEventStore.setState({ events: [], running: [], clearing: false });
  return useEventStore.getState();
}

test("event deletion waits for saved-data removal and keeps errors retryable", async t => {
  const store = setup(t);
  let finish!: () => void;
  let fail = true, calls = 0;
  store.add({ id: "saved", timestamp: 1, title: "Saved", remove: async () => {
    calls++;
    if (fail) throw new Error("disk unavailable");
    await new Promise<void>(resolve => { finish = resolve; });
  } });
  await store.remove("saved");
  assert.equal(useEventStore.getState().events[0].actionError, "disk unavailable");
  fail = false;
  const pending = store.remove("saved");
  await store.remove("saved");
  await store.runAction("saved");
  assert.equal(calls, 2);
  assert.deepEqual(useEventStore.getState().running, ["saved"]);
  assert.equal(useEventStore.getState().events.length, 1);
  finish(); await pending;
  assert.equal(useEventStore.getState().events.length, 0);
  assert.deepEqual(useEventStore.getState().running, []);
});

test("clear removes its snapshot, retains failed entries, and preserves new events", async t => {
  const store = setup(t);
  let finish!: () => void, calls = 0;
  store.add({ id: "plain", timestamp: 1, title: "Plain" });
  store.add({ id: "failed", timestamp: 2, title: "Failed", remove: async () => { throw new Error("read-only disk"); } });
  store.add({ id: "first", timestamp: 3, title: "First", remove: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const pending = store.clear();
  assert.equal(useEventStore.getState().clearing, true);
  await store.clear(); await store.remove("first");
  store.add({ id: "new", timestamp: 4, title: "Arrived during clear" });
  finish(); await pending;
  assert.equal(calls, 1);
  assert.deepEqual(useEventStore.getState().events.map(event => event.id), ["new", "failed"]);
  assert.equal(useEventStore.getState().events[1].actionError, "read-only disk");
  assert.equal(useEventStore.getState().clearing, false);
});

test("clear skips a running restore and cannot start another event action", async t => {
  const store = setup(t);
  let finish!: () => void;
  let purges = 0;
  store.add({ id: "busy", timestamp: 2, title: "Busy", remove: async () => { purges++; },
    action: { label: "Undo", run: () => new Promise(resolve => { finish = resolve; }) } });
  store.add({ id: "plain", timestamp: 1, title: "Plain" });
  const pending = store.runAction("busy");
  await store.clear();
  assert.deepEqual(useEventStore.getState().events.map(event => event.id), ["busy"]);
  assert.equal(purges, 0);
  finish(); await pending;
  assert.equal(useEventStore.getState().events.length, 0);
});

test("a completed deletion cannot remove a replacement event with the same ID", async t => {
  const store = setup(t);
  let finish!: () => void;
  store.add({ id: "reused", timestamp: 1, title: "Old", remove: () => new Promise(resolve => { finish = resolve; }) });
  const pending = store.remove("reused");
  store.add({ id: "reused", timestamp: 2, title: "New" });
  finish(); await pending;
  assert.equal(useEventStore.getState().events[0].title, "New");
});

test("clear does not delete a replacement for a later item in its snapshot", async t => {
  const store = setup(t);
  let finish!: () => void;
  let purges = 0;
  store.add({ id: "later", timestamp: 1, title: "Old", remove: async () => { purges++; } });
  store.add({ id: "first", timestamp: 2, title: "First", remove: () => new Promise(resolve => { finish = resolve; }) });
  const pending = store.clear();
  store.add({ id: "later", timestamp: 3, title: "New" });
  finish(); await pending;
  assert.equal(purges, 0);
  assert.equal(useEventStore.getState().events[0].title, "New");
});
