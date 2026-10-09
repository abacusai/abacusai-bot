import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LAST_SHIPPED = "1.0.85";
/** Test installers stay below their production release in update ordering. */
export const assertBuildVersion = (version, testBuild = false) => {
  if (
    testBuild &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-test\.[1-9]\d*$/.test(version)
  )
    return version;
  return assertUpgradeVersion(version);
};
export const assertUpgradeVersion = (version, lastShipped = LAST_SHIPPED) => {
  const parse = (value) => {
    if (!/^\d+\.\d+\.\d+$/.test(value))
      throw new Error(`Invalid foundation release version: ${value}`);
    return value.split(".").map(Number);
  };
  const candidate = parse(version),
    shipped = parse(lastShipped);
  const first = candidate.findIndex((value, index) => value !== shipped[index]);
  if (first === -1 || candidate[first] < shipped[first])
    throw new Error(
      `Release ${version} must be newer than last shipped ${lastShipped}`
    );
  return version;
};

/** Read the package.json extracted from the installer, its generated feed, and experience manifest. */
export const checkReleaseVersions = (
  installerPackage,
  feed,
  experienceManifest
) => {
  const installer = JSON.parse(
    fs.readFileSync(installerPackage, "utf8")
  ).version;
  const feedVersion = /^version:\s*["']?([\d.]+)["']?\s*$/m.exec(
    fs.readFileSync(feed, "utf8")
  )?.[1];
  const foundation = JSON.parse(
    fs.readFileSync(experienceManifest, "utf8")
  ).foundation;
  if (installer !== feedVersion || installer !== foundation)
    throw new Error(
      `Release stamps must agree: installer=${installer}, feed=${feedVersion}, experience=${foundation}`
    );
  return assertUpgradeVersion(installer);
};
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 5)
    throw new Error(
      "Required: <installer package.json> <latest*.yml> <experience manifest.json>"
    );
  console.log(
    `Release stamps agree at ${checkReleaseVersions(...process.argv.slice(2))}`
  );
}
