import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyRegistryOverrides } from "./registry-overrides.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const before = "export const compact = false;\n";
const after = "export const compact = true;\n";
const patch =
  "--- a/src/ui/button.tsx\n+++ b/src/ui/button.tsx\n@@ -1 +1 @@\n-export const compact = false;\n+export const compact = true;\n";
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "registry-patch-test-"));
  const overrides = join(directory, "overrides");
  mkdirSync(join(directory, "src/ui"), { recursive: true });
  mkdirSync(overrides);
  writeFileSync(join(directory, "src/ui/button.tsx"), before);
  writeFileSync(join(overrides, "renderer.patch"), patch);
  const manifest = {
    snapshot: "2026-09-30",
    patchSha256: hash(patch),
    files: [{ name: "button.tsx", before: hash(before), after: hash(after) }],
  };
  const save = () =>
    writeFileSync(join(overrides, "manifest.json"), JSON.stringify(manifest));
  save();
  return {
    directory,
    overrides,
    manifest,
    save,
    snapshot: "2026-09-30",
    rsc: false,
  };
};

test("replays a reviewed UI adaptation and requires its exact input and output", () => {
  const options = fixture();
  try {
    applyRegistryOverrides(options);
    assert.equal(
      readFileSync(join(options.directory, "src/ui/button.tsx"), "utf8"),
      after
    );
    assert.throws(
      () => applyRegistryOverrides(options),
      /Registry input changed/
    );
  } finally {
    rmSync(options.directory, { recursive: true, force: true });
  }
});

test("rejects upstream drift, patch corruption, escaped paths and changed output expectations", () => {
  for (const kind of ["input", "checksum", "path", "output"]) {
    const options = fixture();
    try {
      if (kind === "input")
        writeFileSync(
          join(options.directory, "src/ui/button.tsx"),
          "changed\n"
        );
      if (kind === "checksum")
        writeFileSync(
          join(options.overrides, "renderer.patch"),
          patch + "changed"
        );
      if (kind === "path") {
        const escaped = patch.replaceAll("src/ui/button.tsx", "../outside.tsx");
        writeFileSync(join(options.overrides, "renderer.patch"), escaped);
        options.manifest.patchSha256 = hash(escaped);
      }
      if (kind === "output")
        options.manifest.files[0].after = hash("unexpected\n");
      options.save();
      assert.throws(
        () => applyRegistryOverrides(options),
        {
          input: /Registry input changed/,
          checksum: /checksum changed/,
          path: /Unexpected local UI patch path/,
          output: /patch output changed/,
        }[kind]
      );
    } finally {
      rmSync(options.directory, { recursive: true, force: true });
    }
  }
});
