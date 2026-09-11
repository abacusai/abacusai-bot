import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Metadata, MetadataKind } from "@tufjs/models";
import type { JSONObject } from "@tufjs/models/dist/utils";
import { test } from "vitest";

import { buildExperience } from "./experience.ts";
import { publishExperience, refreshMetadata } from "./repository.ts";

const readJson = async (file: string): Promise<JSONObject> => {
  const value: unknown = JSON.parse(await fs.readFile(file, "utf-8"));
  assert.ok(typeof value === "object" && value !== null);
  return value as JSONObject;
};

void test("refreshMetadata re-signs snapshot and timestamp, not targets", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "updater-repo-"));
  try {
    const renderer = path.join(work, "renderer-src");
    const agent = path.join(work, "agent-src");
    await fs.mkdir(renderer, { recursive: true });
    await fs.mkdir(agent, { recursive: true });
    await fs.writeFile(path.join(renderer, "index.html"), "<html/>");
    await fs.writeFile(path.join(agent, "index.mjs"), "console.log(1)");
    const output = path.join(work, "experience");
    await buildExperience({ agent, foundation: "1.2.3", output, renderer });

    const repo = path.join(work, "repo");
    await publishExperience(
      path.join(output, "experience.zip"),
      "experience/latest.zip",
      repo
    );

    const metadataDir = path.join(repo, "repository", "metadata");
    const timestampBefore = Metadata.fromJSON(
      MetadataKind.Timestamp,
      await readJson(path.join(metadataDir, "timestamp.json"))
    );
    assert.equal(timestampBefore.signed.version, 2);

    await refreshMetadata(repo);

    const timestamp = Metadata.fromJSON(
      MetadataKind.Timestamp,
      await readJson(path.join(metadataDir, "timestamp.json"))
    );
    assert.equal(timestamp.signed.version, 3);

    const snapshot = Metadata.fromJSON(
      MetadataKind.Snapshot,
      await readJson(path.join(metadataDir, "3.snapshot.json"))
    );
    assert.equal(snapshot.signed.version, 3);
    assert.equal(timestamp.signed.snapshotMeta.version, 3);

    // Targets are untouched: still version 2, and the refreshed snapshot
    // points at the existing bytes.
    const targets = Metadata.fromJSON(
      MetadataKind.Targets,
      await readJson(path.join(metadataDir, "2.targets.json"))
    );
    assert.equal(targets.signed.version, 2);
    const entries = await fs.readdir(metadataDir);
    assert.ok(!entries.includes("3.targets.json"));
    assert.equal(snapshot.signed.meta["targets.json"]?.version, 2);
  } finally {
    await fs.rm(work, { force: true, recursive: true });
  }
});

void test("bootstrap from existing keys recreates version-1 metadata", async () => {
  const fsp = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const {
    bootstrapRepositoryFromKeys,
    initializeDevRepository,
    publishExperience,
  } = await import("./repository.ts");
  const { updaterPaths } = await import("./paths.ts");
  const { buildExperience } = await import("./experience.ts");

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tuf-bootstrap-"));

  try {
    const paths = updaterPaths(root);

    // The ceremony: keys plus a trusted root exist; the metadata does not
    // (a fresh production prefix).
    await initializeDevRepository(paths);
    await fsp.rm(path.join(root, "repository", "metadata"), {
      force: true,
      recursive: true,
    });

    await bootstrapRepositoryFromKeys(root);

    for (const file of [
      "1.root.json",
      "1.targets.json",
      "1.snapshot.json",
      "timestamp.json",
    ]) {
      await fsp.access(path.join(root, "repository", "metadata", file));
    }

    // And the bootstrapped repository accepts a publish.
    const source = await fsp.mkdtemp(path.join(os.tmpdir(), "exp-src-"));
    const renderer = path.join(source, "renderer");
    const agent = path.join(source, "agent");

    await fsp.mkdir(renderer, { recursive: true });
    await fsp.mkdir(agent, { recursive: true });
    await fsp.writeFile(path.join(renderer, "index.html"), "<html></html>");
    await fsp.writeFile(path.join(agent, "main.js"), "process.exit(0);");
    const output = path.join(source, "out");

    await buildExperience({ agent, foundation: "1.2.3", output, renderer });
    const target = await publishExperience(
      path.join(output, "experience.zip"),
      undefined,
      root
    );

    assert.equal(target, "experience/latest.zip");
    await fsp.rm(source, { force: true, recursive: true });
  } finally {
    await fsp.rm(root, { force: true, recursive: true });
  }
});

void test("bootstrap refuses a repository that already has metadata", async () => {
  const fsp = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { bootstrapRepositoryFromKeys, initializeDevRepository } =
    await import("./repository.ts");
  const { updaterPaths } = await import("./paths.ts");

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tuf-bootstrap-"));

  try {
    await initializeDevRepository(updaterPaths(root));
    await assert.rejects(
      () => bootstrapRepositoryFromKeys(root),
      /already has metadata/u
    );
  } finally {
    await fsp.rm(root, { force: true, recursive: true });
  }
});
