import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { test } from "vitest";

import { buildManifest } from "./manifest.ts";

const parse = (payload: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(payload);
  assert.ok(typeof value === "object" && value !== null);
  return Object.fromEntries(Object.entries(value));
};

void test("manifest digests are deterministic and self-consistent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-"));
  await fs.mkdir(path.join(root, "agent"), { recursive: true });
  await fs.mkdir(path.join(root, "renderer"), { recursive: true });
  await fs.writeFile(path.join(root, "agent", "index.mjs"), "console.log(1)");
  await fs.writeFile(path.join(root, "renderer", "index.html"), "<html/>");

  const first = parse(await buildManifest(root, "1.2.3"));
  const second = parse(await buildManifest(root, "1.2.3"));
  assert.deepEqual(first, second);
  assert.equal(first["protocol"], "abacus.desktop/1");
  assert.equal(first["foundation"], "1.2.3");

  // The experience identity is the digest of the canonical identity object,
  // exactly as the desktop verifier recomputes it.
  const identity = JSON.stringify({
    files: first["files"],
    foundation: first["foundation"],
    foundationApi: first["foundationApi"],
    protocol: first["protocol"],
  });
  assert.equal(
    createHash("sha256").update(identity).digest("hex"),
    first["experienceVersion"]
  );
  // The stamp is inside the identity, so another release hashes differently.
  const other = parse(await buildManifest(root, "1.2.4"));
  assert.notEqual(other["experienceVersion"], first["experienceVersion"]);
  assert.deepEqual(other["files"], first["files"]);

  await fs.rm(root, { force: true, recursive: true });
});
