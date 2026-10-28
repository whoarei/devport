import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

// One stable channel; reject prereleases, build metadata, leading zeros and shell text.
export function releaseVersion(tag) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) throw new Error("发布标签必须为稳定版本 vX.Y.Z");
  const version = tag.slice(1);
  if (version.split(".").some((part) => Number(part) > 65535)) throw new Error("Windows 版本字段必须不大于 65535");
  return version;
}

export function syncVersion(root, tag) {
  const version = releaseVersion(tag);
  const jsonFiles = ["package.json", "package-lock.json", "src-tauri/tauri.conf.json"];
  const changes = jsonFiles.map((file) => {
    const json = JSON.parse(readFileSync(join(root, file), "utf8"));
    json.version = version;
    if (file === "package-lock.json") json.packages[""].version = version;
    return [file, `${JSON.stringify(json, null, 2)}\n`];
  });
  for (const [file, pattern] of [
    ["src-tauri/Cargo.toml", /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+("\r?\n)/],
    ["src-tauri/Cargo.lock", /(\[\[package\]\]\r?\nname = "devport"\r?\nversion = ")[^"]+("\r?\n)/],
  ]) {
    const source = readFileSync(join(root, file), "utf8");
    if (!pattern.test(source)) throw new Error(`找不到应用版本：${file}`);
    changes.push([file, source.replace(pattern, (_, before, after) => `${before}${version}${after}`)]);
  }
  for (const [file, contents] of changes) writeFileSync(join(root, file), contents);
  return version;
}

const legacyRepository = "whoarei/remote-runner";
const currentRepository = "whoarei/devport";

function windowsPlatforms(manifest, version) {
  if (manifest.version !== version) throw new Error("更新清单版本与标签不一致");
  const entries = Object.entries(manifest.platforms ?? {});
  if (!entries.length || entries.some(([key]) => !["windows-x86_64", "windows-x86_64-nsis"].includes(key))) throw new Error("更新清单平台无效");
  return entries.map(([, platform]) => platform);
}

function installerAsset(platform, version, repositories) {
  if (!platform?.signature?.trim()) throw new Error("更新清单缺少签名");
  const prefix = repositories.map((repo) => `https://github.com/${repo}/releases/download/v${version}/`).find((prefix) => platform.url?.startsWith(prefix));
  if (!prefix) throw new Error("更新清单地址无效");
  const name = platform.url.slice(prefix.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*-setup\.exe$/.test(name)) throw new Error("更新清单必须指向 NSIS exe");
  return name;
}

// Versions through 0.24.2 only accept the old repository URL. GitHub redirects it
// to DevPort; the signed installer bytes and signature are unchanged.
export function bridgeUpdaterManifest(manifest, version) {
  const bridged = structuredClone(manifest);
  for (const platform of windowsPlatforms(bridged, version)) {
    const name = installerAsset(platform, version, [currentRepository, legacyRepository]);
    platform.url = `https://github.com/${legacyRepository}/releases/download/v${version}/${name}`;
  }
  return bridged;
}

export function canonicalUpdaterManifest(manifest, version) {
  const canonical = structuredClone(manifest);
  for (const platform of windowsPlatforms(canonical, version)) {
    const name = installerAsset(platform, version, [currentRepository, legacyRepository]);
    platform.url = `https://github.com/${currentRepository}/releases/download/v${version}/${name}`;
  }
  return canonical;
}

export function validateManifest(manifest, assets, version, channel = "legacy") {
  if (!["legacy", "devport"].includes(channel)) throw new Error("更新通道无效");
  for (const platform of windowsPlatforms(manifest, version)) {
    const name = installerAsset(platform, version, [channel === "legacy" ? legacyRepository : currentRepository]);
    for (const asset of [name, `${name}.sig`, `DevPort_${version}_x64-portable.exe`]) {
      if (!assets.some((entry) => entry.name === asset && entry.size > 0)) throw new Error(`Release 缺少产物：${asset}`);
    }
  }
}

export function validateUpdaterManifests(legacy, canonical, assets, version) {
  validateManifest(legacy, assets, version);
  validateManifest(canonical, assets, version, "devport");
  if (!isDeepStrictEqual(bridgeUpdaterManifest(canonical, version), legacy)) throw new Error("新旧更新清单不一致");
}
