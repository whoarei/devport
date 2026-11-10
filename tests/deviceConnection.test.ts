import test from "node:test";
import assert from "node:assert/strict";
import { api, type HostKeyChange } from "../src/api";
import { emptyDevice } from "../src/components/DeviceEditor";
import { testDeviceConnection } from "../src/deviceConnection";
import { SshHostKeyDialog } from "../src/components/SshHostKeyDialog";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "../src/i18n";

const device = { ...emptyDevice(), name: "box", host: "example.com" };
const change: HostKeyChange = { addr: "example.com:22", saved_fingerprint: "SHA256:old", received_fingerprint: "SHA256:new" };
const changed = (value = change) => ({ code: "ssh_host_key_changed", message: "changed", ...value });

test("canceling a changed key keeps the old trust and never retries", async (t) => {
  const attempt = t.mock.method(api, "testDevice", async () => { throw changed(); });
  let prompted = 0;
  assert.equal(await testDeviceConnection(device, async (value) => {
    prompted++;
    assert.deepEqual(value, change);
    return false;
  }), null);
  assert.equal(prompted, 1);
  assert.equal(attempt.mock.callCount(), 1);
});

test("approval retries with only the exact host and fingerprints shown", async (t) => {
  let calls = 0;
  t.mock.method(api, "testDevice", async (target, confirmation) => {
    assert.equal(target, device);
    if (++calls === 1) { assert.equal(confirmation, undefined); throw changed(); }
    assert.deepEqual(confirmation, change);
    return "connected";
  });
  assert.equal(await testDeviceConnection(device, async () => true), "connected");
  assert.equal(calls, 2);
});

test("a different key on retry requires a fresh confirmation", async (t) => {
  const third = { ...change, received_fingerprint: "SHA256:third" };
  const prompts: HostKeyChange[] = [];
  const attempt = t.mock.method(api, "testDevice", async (_target, confirmation) => {
    if (!confirmation) throw changed();
    assert.deepEqual(confirmation, change);
    throw changed(third);
  });
  assert.equal(await testDeviceConnection(device, async (value) => {
    prompts.push(value);
    return prompts.length === 1;
  }), null);
  assert.deepEqual(prompts, [change, third]);
  assert.equal(attempt.mock.callCount(), 2);
});

test("ordinary connection errors and malformed changes never offer replacement", async (t) => {
  const errors = ["invalid known_hosts.json", "io error: access denied", new Error("authentication failed"),
    { ...changed(), received_fingerprint: null }, { ...changed(), code: "other" }];
  const attempt = t.mock.method(api, "testDevice", async () => "unused");
  for (const error of errors) {
    attempt.mock.mockImplementation(async () => { throw error; });
    await assert.rejects(testDeviceConnection(device, async () => { assert.fail("must not prompt"); }), (value) => value === error);
  }
});

test("a retry authentication error is reported without another replacement prompt", async (t) => {
  let prompted = 0;
  const failure = new Error("authentication failed");
  t.mock.method(api, "testDevice", async (_target, confirmation) => {
    if (!confirmation) throw changed();
    throw failure;
  });
  await assert.rejects(testDeviceConnection(device, async () => { prompted++; return true; }), failure);
  assert.equal(prompted, 1);
});

test("host key prompts show address, both fingerprints, and translated actions", async () => {
  const original = i18n.language;
  try {
    for (const language of ["zh", "en"]) {
      await i18n.changeLanguage(language);
      const html = renderToStaticMarkup(React.createElement(SshHostKeyDialog, { request: { change, respond() {} } }));
      assert.ok(html.includes(change.addr));
      assert.ok(html.includes(change.saved_fingerprint));
      assert.ok(html.includes(change.received_fingerprint));
      assert.ok(html.includes(i18n.t("dialog.cancel")));
      assert.ok(html.includes(i18n.t("device.hostKeyReplace")));
    }
  } finally { await i18n.changeLanguage(original); }
});
