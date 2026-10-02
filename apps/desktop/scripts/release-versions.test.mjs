import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const desktop = path.resolve(import.meta.dirname, "..");
test("default foundation release is newer than shipped 1.0.85", () => {
  const version = JSON.parse(
    fs.readFileSync(path.join(desktop, "package.json"))
  ).version;
  const parts = version.split(".").map(Number);
  assert.ok(
    parts[0] > 1 || (parts[0] === 1 && (parts[1] > 0 || parts[2] > 85)),
    version
  );
});
test("installer, feed and experience stamps must agree, including pipeline overrides", async () => {
  const { checkReleaseVersions } = await import("./check-release-versions.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-versions-"));
  try {
    const installer = path.join(root, "package.json"),
      feed = path.join(root, "latest.yml"),
      manifest = path.join(root, "manifest.json");
    const write = (version) => {
      fs.writeFileSync(installer, JSON.stringify({ version }));
      fs.writeFileSync(
        feed,
        `version: ${version}\nfiles:\n  - url: AbacusAI-Bot-${version}-arm64.zip\n`
      );
      fs.writeFileSync(manifest, JSON.stringify({ foundation: version }));
    };
    for (const version of ["1.0.86", "1.0.99"]) {
      write(version);
      assert.equal(checkReleaseVersions(installer, feed, manifest), version);
    }
    write("1.0.85");
    assert.throws(
      () => checkReleaseVersions(installer, feed, manifest),
      /newer/
    );
    write("1.0.86");
    fs.writeFileSync(manifest, JSON.stringify({ foundation: "1.0.13" }));
    assert.throws(
      () => checkReleaseVersions(installer, feed, manifest),
      /agree/
    );
    write("1.0.86");
    fs.writeFileSync(feed, "version: 1.0.87\n");
    assert.throws(
      () => checkReleaseVersions(installer, feed, manifest),
      /agree/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
