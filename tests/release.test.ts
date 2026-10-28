import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseVersion, syncVersion, validateManifest, bridgeUpdaterManifest, canonicalUpdaterManifest, validateUpdaterManifests } from "../scripts/release-helpers.mjs";

test("release tags reject unstable, malformed and unsafe values", () => {
  assert.equal(releaseVersion("v0.10.2"), "0.10.2");
  for (const tag of ["v01.2.3", "v1.2.3-rc.1", "v1.2.3+build", "v1.2.3junk", "v1.2.3\n", "v65536.0.0", "v1.2.3'; whoami"]) assert.throws(() => releaseVersion(tag));
});

test("version synchronization changes app metadata and both lockfiles only", () => {
  const root = mkdtempSync(join(tmpdir(), "rr-release-"));
  try {
    mkdirSync(join(root, "src-tauri"));
    for (const file of ["package.json", "src-tauri/tauri.conf.json"]) writeFileSync(join(root, file), '{"version":"0.2.0"}');
    writeFileSync(join(root, "package-lock.json"), '{"version":"0.2.0","packages":{"":{"version":"0.2.0"},"node_modules/example":{"version":"1.0.0"}}}');
    writeFileSync(join(root, "src-tauri/Cargo.toml"), '[dependencies]\nfoo = { version = "2" }\n[package]\nname = "devport"\nversion = "0.2.0"\n');
    writeFileSync(join(root, "src-tauri/Cargo.lock"), '[[package]]\nname = "example"\nversion = "9.0.0"\n\n[[package]]\nname = "devport"\nversion = "0.2.0"\n');
    syncVersion(root, "v0.10.2");
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    assert.equal(lock.version, "0.10.2");
    assert.equal(lock.packages[""].version, "0.10.2");
    assert.equal(lock.packages["node_modules/example"].version, "1.0.0");
    assert.match(readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8"), /foo = \{ version = "2" \}/);
    assert.match(readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8"), /name = "example"\nversion = "9.0.0"/);
    assert.match(readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8"), /name = "devport"\nversion = "0.10.2"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release manifest requires the signed installer and portable assets", () => {
  const name = "Remote.Runner_0.3.0_x64-setup.exe";
  const platform = { url: `https://github.com/whoarei/remote-runner/releases/download/v0.3.0/${name}`, signature: "signature" };
  const manifest = { version: "0.3.0", platforms: { "windows-x86_64": platform } };
  const assets = [name, `${name}.sig`, "DevPort_0.3.0_x64-portable.exe"].map((name) => ({ name, size: 42 }));
  validateManifest(manifest, assets, "0.3.0");
  assert.throws(() => validateManifest(manifest, assets.slice(0, 1), "0.3.0"));
  assert.throws(() => validateManifest(manifest, assets, "0.4.0"));
  assert.throws(() => validateManifest({ ...manifest, platforms: {} }, assets, "0.3.0"));
  for (const url of [platform.url.replace("github.com", "evil.example"), platform.url.replace("-setup.exe", "-setup.nsis.zip")]) {
    assert.throws(() => validateManifest({ ...manifest, platforms: { "windows-x86_64": { ...platform, url } } }, assets, "0.3.0"));
  }
});

test("renamed releases retain an update path accepted by installed legacy clients", () => {
  const name = "DevPort_0.25.0_x64-setup.exe";
  const url = `https://github.com/whoarei/devport/releases/download/v0.25.0/${name}`;
  const signature = "signed-installer-bytes";
  const manifest = { version: "0.25.0", notes: "DevPort", pub_date: "2026-10-28T00:00:00Z", platforms: {
    "windows-x86_64": { url, signature }, "windows-x86_64-nsis": { url, signature },
  } };
  const assets = [name, `${name}.sig`, "DevPort_0.25.0_x64-portable.exe"].map((name) => ({ name, size: 42 }));
  assert.throws(() => validateManifest(manifest, assets, "0.25.0"));
  const bridged = bridgeUpdaterManifest(manifest, "0.25.0");
  validateManifest(bridged, assets, "0.25.0");
  const canonical = canonicalUpdaterManifest(bridged, "0.25.0");
  assert.deepEqual(canonical, manifest);
  validateUpdaterManifests(bridged, canonical, assets, "0.25.0");
  assert.throws(() => validateUpdaterManifests({ ...bridged, notes: "different release" }, canonical, assets, "0.25.0"));
  assert.throws(() => validateUpdaterManifests(bridged, bridged, assets, "0.25.0"));
  for (const platform of Object.values(bridged.platforms)) {
    // This is the exact prefix enforced by released versions through 0.24.2.
    assert.equal(platform.url, `https://github.com/whoarei/remote-runner/releases/download/v0.25.0/${name}`);
    assert.equal(platform.signature, signature);
  }
  assert.equal(bridged.notes, manifest.notes);
  assert.equal(bridged.pub_date, manifest.pub_date);
  assert.equal(manifest.platforms["windows-x86_64"].url, url);
  assert.deepEqual(bridgeUpdaterManifest(bridged, "0.25.0"), bridged);
  assert.throws(() => bridgeUpdaterManifest(manifest, "0.26.0"));
  for (const invalid of [url.replace("github.com", "evil.example"), url.replace("whoarei/devport", "other/devport"), url.replace(name, `nested%2f${name}`), `${url}?redirect=1`, url.replace("/v0.25.0/", "/v0.26.0/")]) {
    assert.throws(() => bridgeUpdaterManifest({ ...manifest, platforms: { "windows-x86_64": { url: invalid, signature } } }, "0.25.0"));
  }
  assert.throws(() => bridgeUpdaterManifest({ ...manifest, platforms: { "windows-x86_64": { url, signature: "" } } }, "0.25.0"));
});
