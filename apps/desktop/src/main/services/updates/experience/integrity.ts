/**
 * Recompute every digest of an experience tree from the builder's JSON canon
 * (`apps/updater/src/manifest.ts`: sorted keys, compact separators, ASCII
 * paths); change both together or digests diverge. Validation is by hand
 * because the shape is small and this runs before anything else can.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { EXPERIENCE_PROTOCOL, FOUNDATION_API } from "#shared/experience";

export interface ExperienceFileEntry {
  readonly sha256: string;
  readonly size: number;
}

export interface ExperienceManifest {
  readonly agentVersion: string;
  readonly experienceVersion: string;
  readonly files: Record<string, ExperienceFileEntry>;
  readonly foundation: string;
  readonly foundationApi: number;
  readonly protocol: string;
  readonly rendererVersion: string;
}

const DIGEST = /^[\da-f]{64}$/u;

const parseManifest = (
  raw: unknown,
  expectedFoundation: string
): ExperienceManifest => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Experience manifest is not an object");
  }

  const value = raw as Record<string, unknown>;
  const digestField = (name: string): string => {
    const digest = value[name];

    if (typeof digest !== "string" || !DIGEST.test(digest)) {
      throw new Error(`Experience manifest ${name} is not a SHA-256 digest`);
    }

    return digest;
  };

  // An older bundle reverts the renderer its installer shipped; a newer one
  // wants a main process this shell does not have.
  if (value.foundation !== expectedFoundation) {
    throw new Error(
      `Experience manifest was built for foundation ${String(value.foundation)}, not ${expectedFoundation}`
    );
  }

  if (value.foundationApi !== FOUNDATION_API) {
    throw new Error("Experience manifest names a different foundation API");
  }

  if (value.protocol !== EXPERIENCE_PROTOCOL) {
    throw new Error("Experience manifest names a different protocol");
  }

  const rawFiles = value.files;

  if (typeof rawFiles !== "object" || rawFiles === null) {
    throw new Error("Experience manifest has no file table");
  }

  const files: Record<string, ExperienceFileEntry> = {};

  for (const [name, entry] of Object.entries(
    rawFiles as Record<string, unknown>
  )) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Experience manifest entry is malformed: ${name}`);
    }

    const { sha256, size } = entry as Record<string, unknown>;

    if (
      typeof sha256 !== "string" ||
      !DIGEST.test(sha256) ||
      typeof size !== "number" ||
      !Number.isInteger(size) ||
      size < 0
    ) {
      throw new Error(`Experience manifest entry is malformed: ${name}`);
    }

    files[name] = { sha256, size };
  }

  return {
    agentVersion: digestField("agentVersion"),
    experienceVersion: digestField("experienceVersion"),
    files,
    foundation: expectedFoundation,
    foundationApi: FOUNDATION_API,
    protocol: EXPERIENCE_PROTOCOL,
    rendererVersion: digestField("rendererVersion"),
  };
};

const compareNames = (left: string, right: string): number => {
  if (left < right) return -1;

  return left > right ? 1 : 0;
};

const listFiles = async (root: string, directory = root): Promise<string[]> => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      // The shell's `node_modules` link is never part of the signed tree.
      if (directory === root && entry.name === "node_modules") {
        return [];
      }

      const absolute = path.join(directory, entry.name);

      return entry.isDirectory() && !entry.isSymbolicLink()
        ? await listFiles(root, absolute)
        : [path.relative(root, absolute).split(path.sep).join("/")];
    })
  );

  return files.flat();
};

const verifyTree = async (
  root: string,
  manifest: ExperienceManifest
): Promise<void> => {
  const actual = new Set(await listFiles(root));

  actual.delete("manifest.json");

  if (actual.size !== Object.keys(manifest.files).length) {
    throw new Error("Experience contents do not match the manifest");
  }

  for (const [relative, expected] of Object.entries(manifest.files)) {
    if (!actual.delete(relative) || path.isAbsolute(relative)) {
      throw new Error(`Invalid experience path: ${relative}`);
    }

    const absolute = path.resolve(root, relative);

    if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) {
      throw new Error(`Experience path escapes its root: ${relative}`);
    }

    // Sequential verification bounds startup memory for large experiences.
    const stat = await fs.lstat(absolute);

    if (!stat.isFile()) {
      throw new Error(`Experience entry is not a regular file: ${relative}`);
    }

    const data = await fs.readFile(absolute);
    const digest = createHash("sha256").update(data).digest("hex");

    if (data.byteLength !== expected.size || digest !== expected.sha256) {
      throw new Error(`Experience file differs: ${relative}`);
    }
  }
};

/**
 * Checks manifest shape, foundation, optional manifest digest, every file's
 * size and SHA-256, and the recomputed component identities.
 */
export const verifyExperience = async (
  root: string,
  expectedFoundation: string,
  expectedSha256?: string
): Promise<ExperienceManifest> => {
  const data = await fs.readFile(path.join(root, "manifest.json"));

  if (
    expectedSha256 !== undefined &&
    createHash("sha256").update(data).digest("hex") !== expectedSha256
  ) {
    throw new Error("Manifest does not match its recorded digest");
  }

  const manifest = parseManifest(
    JSON.parse(data.toString("utf-8")),
    expectedFoundation
  );

  await verifyTree(root, manifest);

  if (
    manifest.files["agent/main.js"] === undefined ||
    manifest.files["renderer/index.html"] === undefined
  ) {
    throw new Error("Experience is missing an agent or renderer entry point");
  }

  const files = Object.fromEntries(
    Object.entries(manifest.files)
      .toSorted(([left], [right]) => compareNames(left, right))
      .map(([name, file]) => [name, { sha256: file.sha256, size: file.size }])
  );
  const identity = (prefix: string): string =>
    createHash("sha256")
      .update(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(files)
              .filter(([name]) => name.startsWith(prefix))
              .map(([name, file]) => [name.slice(prefix.length), file])
          )
        )
      )
      .digest("hex");

  if (
    identity("agent/") !== manifest.agentVersion ||
    identity("renderer/") !== manifest.rendererVersion
  ) {
    throw new Error("Experience component version does not match its contents");
  }

  const experienceIdentity = JSON.stringify({
    files,
    foundation: manifest.foundation,
    foundationApi: manifest.foundationApi,
    protocol: manifest.protocol,
  });

  if (
    createHash("sha256").update(experienceIdentity).digest("hex") !==
    manifest.experienceVersion
  ) {
    throw new Error("Experience version does not match its contents");
  }

  return manifest;
};
