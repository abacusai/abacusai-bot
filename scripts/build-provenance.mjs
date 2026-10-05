import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
export const buildConstants = () => {
  const experience = read("packages/contract/src/experience.ts");
  const foundationApi = Number(
    experience.match(/FOUNDATION_API\s*=\s*(\d+)/)?.[1]
  );
  const protocol = experience.match(/EXPERIENCE_PROTOCOL\s*=\s*"([^"]+)"/)?.[1];
  if (!foundationApi || !protocol)
    throw new Error("Cannot read source build compatibility constants");
  return { foundationApi, protocol, generation: "wco" };
};
export const buildProvenance = (env = process.env) => {
  const pinned = env.ABACUS_BUILD_COMMIT;
  if ((env.CI || env.ABACUS_RELEASE === "1") && !pinned)
    throw new Error(
      "ABACUS_BUILD_COMMIT is required for CI and release builds"
    );
  const git = (args) =>
    execFileSync(process.platform === "win32" ? "git" : "/usr/bin/git", args, {
      cwd: root,
      encoding: "utf8",
    }).trim();
  const commit = pinned ?? git(["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40,64}$/.test(commit))
    throw new Error("ABACUS_BUILD_COMMIT must be a full commit id");
  // A caller cannot label a different checkout with the pinned release commit.
  if (pinned && pinned !== git(["rev-parse", "HEAD"]))
    throw new Error("Pinned build commit differs from the checkout");
  return {
    commit,
    dirty: git(["status", "--porcelain", "--untracked-files=no"]) !== "",
    ...buildConstants(),
    builtAt: new Date().toISOString(),
  };
};
export const writeBuildProvenance = (directory) => {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "build.json"),
    JSON.stringify(buildProvenance()) + "\n"
  );
};
