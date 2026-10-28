import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { releaseVersion, syncVersion, canonicalUpdaterManifest, validateUpdaterManifests, bridgeUpdaterManifest } from "./release-helpers.mjs";

const [command, ...args] = process.argv.slice(2);
if (command === "sync") syncVersion(process.cwd(), args[0]);
else if (command === "bridge") {
  const [file, tag] = args;
  const canonical = canonicalUpdaterManifest(JSON.parse(readFileSync(file, "utf8")), releaseVersion(tag));
  writeFileSync(join(dirname(file), "devport-latest.json"), `${JSON.stringify(canonical, null, 2)}\n`);
  writeFileSync(file, `${JSON.stringify(bridgeUpdaterManifest(canonical, releaseVersion(tag)), null, 2)}\n`);
}
else if (command === "verify") {
  const [manifest, assets, tag] = args;
  validateUpdaterManifests(JSON.parse(readFileSync(manifest, "utf8")), JSON.parse(readFileSync(join(dirname(manifest), "devport-latest.json"), "utf8")), JSON.parse(readFileSync(assets, "utf8")).assets, releaseVersion(tag));
} else throw new Error("Usage: release.mjs sync <tag> | bridge <manifest> <tag> | verify <manifest> <assets> <tag>");
