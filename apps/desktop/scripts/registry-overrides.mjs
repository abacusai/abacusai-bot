import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { registryContent } from "./registry-content.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

/** Replay reviewed renderer adaptations without accepting further registry drift. */
export const applyRegistryOverrides = ({
  directory,
  snapshot,
  overrides,
  rsc,
}) => {
  const manifest = JSON.parse(
    readFileSync(join(overrides, "manifest.json"), "utf8")
  );
  assert.equal(
    manifest.snapshot,
    basename(snapshot),
    "Local UI patch snapshot changed"
  );
  const patch = readFileSync(join(overrides, "renderer.patch"), "utf8");
  assert.equal(
    hash(patch),
    manifest.patchSha256,
    "Local UI patch checksum changed"
  );
  const names = new Set(manifest.files.map(({ name }) => name));
  assert.equal(
    names.size,
    manifest.files.length,
    "Duplicate local UI patch file"
  );
  for (const name of names)
    assert.match(
      name,
      /^[a-z][a-z-]*\.tsx$/,
      "Local UI patches must stay under ui/"
    );
  for (const [, path] of patch.matchAll(/^(?:---|\+\+\+) (\S+)$/gm))
    assert.ok(
      path === "/dev/null" ||
        [...names].some(
          (name) => path === `a/src/ui/${name}` || path === `b/src/ui/${name}`
        ),
      `Unexpected local UI patch path: ${path}`
    );

  const content = (name) => {
    const path = join(directory, "src/ui", name);
    return existsSync(path)
      ? registryContent(readFileSync(path, "utf8"), rsc)
      : null;
  };
  for (const file of manifest.files) {
    const before = content(file.name);
    assert.equal(
      before === null ? null : hash(before),
      file.before,
      `Registry input changed before local patch: ${file.name}`
    );
  }
  for (const file of manifest.files) {
    const before = content(file.name);
    if (before !== null)
      writeFileSync(join(directory, "src/ui", file.name), before);
  }
  execFileSync("git", ["apply", "--check", join(overrides, "renderer.patch")], {
    cwd: directory,
  });
  execFileSync("git", ["apply", join(overrides, "renderer.patch")], {
    cwd: directory,
  });
  for (const file of manifest.files) {
    const after = content(file.name);
    assert.equal(
      after === null ? null : hash(after),
      file.after,
      `Local UI patch output changed: ${file.name}`
    );
  }
};
