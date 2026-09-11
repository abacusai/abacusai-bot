import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";
import type { KeyObject } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { canonicalize } from "@tufjs/canonical-json";
import {
  Key,
  MetaFile,
  Metadata,
  MetadataKind,
  Root,
  Signature,
  Snapshot,
  TargetFile,
  Targets,
  Timestamp,
} from "@tufjs/models";
import type { JSONObject } from "@tufjs/models/dist/utils";

import { updaterPaths } from "./paths.ts";
import type { UpdaterPaths } from "./paths.ts";

/**
 * Development-only TUF repository publisher: one ed25519 key per top-level
 * role, consistent-snapshot metadata. Production promotion signs offline.
 */

const ROLES = ["root", "targets", "snapshot", "timestamp"] as const;
type Role = (typeof ROLES)[number];

const expires = (days: number): string =>
  new Date(Date.now() + days * 86_400_000)
    .toISOString()
    .replace(/\.\d{3}Z$/u, "Z");

// Non-root lifetimes are env-tunable so metadata outlives the republish gap.
const roleDays = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const days = Number(raw);
  return Number.isFinite(days) && days > 0 ? days : fallback;
};

const targetsDays = (): number => roleDays("ABACUSAI_BOT_TUF_TARGETS_DAYS", 90);
const snapshotDays = (): number =>
  roleDays("ABACUSAI_BOT_TUF_SNAPSHOT_DAYS", 30);
const timestampDays = (): number =>
  roleDays("ABACUSAI_BOT_TUF_TIMESTAMP_DAYS", 14);

const writeAtomic = async (
  file: string,
  data: string | Buffer,
  mode = 0o644
): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.tmp`
  );
  const handle = await fs.open(temporary, "w", mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
};

const keyPath = (paths: UpdaterPaths, role: Role): string =>
  path.join(paths.keys, `${role}.pem`);

const publicHex = (publicKey: KeyObject): string => {
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string") {
    throw new TypeError("The generated key has no public component");
  }
  return Buffer.from(jwk.x, "base64url").toString("hex");
};

const keyIdOf = (publicKeyHex: string): string =>
  createHash("sha256")
    .update(
      canonicalize({
        keytype: "ed25519",
        keyval: { public: publicKeyHex },
        scheme: "ed25519",
      })
    )
    .digest("hex");

const signerFor =
  (keyId: string, privateKey: KeyObject) =>
  (data: Buffer): Signature =>
    new Signature({
      keyID: keyId,
      sig: cryptoSign(null, data, privateKey).toString("hex"),
    });

const parseJson = (payload: string): JSONObject => {
  const value: unknown = JSON.parse(payload);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Metadata is not a JSON object");
  }
  return value as JSONObject;
};

const loadRoot = async (paths: UpdaterPaths): Promise<Root> => {
  const data = parseJson(await fs.readFile(paths.bootstrapRoot, "utf-8"));
  return Metadata.fromJSON(MetadataKind.Root, data).signed;
};

const loadSigner = async (paths: UpdaterPaths, root: Root, role: Role) => {
  const keyId = root.roles[role]?.keyIDs.at(0);
  if (keyId === undefined) {
    throw new Error(`Root metadata lists no key for ${role}`);
  }
  const pem = await fs.readFile(keyPath(paths, role), "utf-8");
  return signerFor(keyId, createPrivateKey(pem));
};

const metaFileFrom = (version: number, data: string): MetaFile =>
  new MetaFile({
    hashes: { sha256: createHash("sha256").update(data).digest("hex") },
    length: Buffer.byteLength(data),
    version,
  });

const serialize = (
  metadata: Metadata<Root | Snapshot | Targets | Timestamp>
): string => JSON.stringify(metadata.toJSON());

const currentVersion = async (
  directory: string,
  role: "snapshot" | "targets"
): Promise<number> => {
  const entries = await fs.readdir(directory);
  const versions = entries
    .filter((name) => name.endsWith(`.${role}.json`))
    .map((name) => Number(name.split(".", 1)[0] ?? Number.NaN))
    .filter((version) => Number.isInteger(version));
  if (versions.length === 0) {
    throw new Error(`No ${role} metadata exists`);
  }
  return Math.max(...versions);
};

/**
 * Bootstrap INITIAL metadata from existing keys (no key generation), which is
 * how CI brings the production repository to life from secrets and an empty
 * prefix. Fails closed if any metadata already exists or any key is missing.
 */
export const bootstrapRepositoryFromKeys = async (
  configuredRoot?: string
): Promise<void> => {
  const paths = updaterPaths(configuredRoot);

  for (const role of ["targets", "snapshot", "timestamp"] as const) {
    await fs.access(keyPath(paths, role));
  }

  const rootData = await fs.readFile(paths.bootstrapRoot, "utf-8");
  let hasMetadata = true;

  try {
    const entries = await fs.readdir(paths.metadata);

    hasMetadata = entries.some((name) => name.endsWith(".json"));
  } catch {
    hasMetadata = false;
  }

  if (hasMetadata) {
    throw new Error(
      "Refusing to bootstrap: the repository already has metadata"
    );
  }

  const root = await loadRoot(paths);

  await writeAtomic(path.join(paths.metadata, "1.root.json"), rootData);

  const targets = new Metadata(
    new Targets({
      expires: expires(targetsDays()),
      specVersion: "1.0.0",
      version: 1,
    })
  );

  targets.sign(await loadSigner(paths, root, "targets"));
  const targetsData = serialize(targets);

  await writeAtomic(path.join(paths.metadata, "1.targets.json"), targetsData);

  const snapshot = new Metadata(
    new Snapshot({
      expires: expires(snapshotDays()),
      meta: { "targets.json": metaFileFrom(1, targetsData) },
      specVersion: "1.0.0",
      version: 1,
    })
  );

  snapshot.sign(await loadSigner(paths, root, "snapshot"));
  const snapshotData = serialize(snapshot);

  await writeAtomic(path.join(paths.metadata, "1.snapshot.json"), snapshotData);

  const timestamp = new Metadata(
    new Timestamp({
      expires: expires(timestampDays()),
      snapshotMeta: metaFileFrom(1, snapshotData),
      specVersion: "1.0.0",
      version: 1,
    })
  );

  timestamp.sign(await loadSigner(paths, root, "timestamp"));
  await writeAtomic(
    path.join(paths.metadata, "timestamp.json"),
    serialize(timestamp)
  );
};

export const initializeDevRepository = async (
  paths: UpdaterPaths
): Promise<void> => {
  const required = [
    paths.bootstrapRoot,
    path.join(paths.metadata, "1.root.json"),
    path.join(paths.metadata, "1.targets.json"),
    path.join(paths.metadata, "1.snapshot.json"),
    path.join(paths.metadata, "timestamp.json"),
  ];
  const existing = await Promise.all(
    required.map(async (file) => {
      try {
        await fs.access(file);
        return true;
      } catch {
        return false;
      }
    })
  );
  if (existing.every(Boolean)) {
    return;
  }
  if (existing.some(Boolean)) {
    throw new Error(
      `Incomplete development repository at ${paths.root}; remove it and retry`
    );
  }

  const root = new Root({
    consistentSnapshot: true,
    expires: expires(365),
    specVersion: "1.0.0",
    version: 1,
  });
  const signers = new Map<Role, ReturnType<typeof signerFor>>();
  for (const role of ROLES) {
    const pair = generateKeyPairSync("ed25519");
    const publicKeyHex = publicHex(pair.publicKey);
    const keyId = keyIdOf(publicKeyHex);
    root.addKey(
      new Key({
        keyID: keyId,
        keyType: "ed25519",
        keyVal: { public: publicKeyHex },
        scheme: "ed25519",
      }),
      role
    );
    signers.set(role, signerFor(keyId, pair.privateKey));
    await writeAtomic(
      keyPath(paths, role),
      pair.privateKey.export({ format: "pem", type: "pkcs8" }),
      0o600
    );
  }
  const sign = (
    role: Role,
    metadata: Metadata<Root | Snapshot | Targets | Timestamp>
  ): string => {
    const signer = signers.get(role);
    if (signer === undefined) {
      throw new Error(`No signer for ${role}`);
    }
    metadata.sign(signer);
    return serialize(metadata);
  };

  const rootData = sign("root", new Metadata(root));
  await writeAtomic(paths.bootstrapRoot, rootData);
  await writeAtomic(path.join(paths.metadata, "1.root.json"), rootData);

  const targets = new Metadata(
    new Targets({
      expires: expires(targetsDays()),
      specVersion: "1.0.0",
      version: 1,
    })
  );
  const targetsData = sign("targets", targets);
  await writeAtomic(path.join(paths.metadata, "1.targets.json"), targetsData);

  const snapshot = new Metadata(
    new Snapshot({
      expires: expires(snapshotDays()),
      meta: { "targets.json": metaFileFrom(1, targetsData) },
      specVersion: "1.0.0",
      version: 1,
    })
  );
  const snapshotData = sign("snapshot", snapshot);
  await writeAtomic(path.join(paths.metadata, "1.snapshot.json"), snapshotData);

  const timestamp = new Metadata(
    new Timestamp({
      expires: expires(timestampDays()),
      snapshotMeta: metaFileFrom(1, snapshotData),
      specVersion: "1.0.0",
      version: 1,
    })
  );
  const timestampData = sign("timestamp", timestamp);
  await writeAtomic(path.join(paths.metadata, "timestamp.json"), timestampData);
};

export const publishExperience = async (
  artifact: string,
  targetPath = "experience/latest.zip",
  configuredRoot?: string
): Promise<string> => {
  const paths = updaterPaths(configuredRoot);
  await initializeDevRepository(paths);
  const logical = targetPath.split("/");
  if (
    targetPath.startsWith("/") ||
    logical.some((part) => part === "" || part === "..")
  ) {
    throw new Error("The target path must stay inside the TUF repository");
  }
  const data = await fs.readFile(artifact);
  const root = await loadRoot(paths);

  const targetsVersion = await currentVersion(paths.metadata, "targets");
  const targetsJson = parseJson(
    await fs.readFile(
      path.join(paths.metadata, `${targetsVersion}.targets.json`),
      "utf-8"
    )
  );
  const targetsMetadata = Metadata.fromJSON(MetadataKind.Targets, targetsJson);
  const digest = createHash("sha256").update(data).digest("hex");
  targetsMetadata.signed.targets[targetPath] = new TargetFile({
    hashes: { sha256: digest },
    length: data.byteLength,
    path: targetPath,
  });
  const bumpedTargets = new Metadata(
    new Targets({
      expires: expires(targetsDays()),
      specVersion: targetsMetadata.signed.specVersion,
      targets: targetsMetadata.signed.targets,
      version: targetsMetadata.signed.version + 1,
      ...(targetsMetadata.signed.delegations === undefined
        ? {}
        : { delegations: targetsMetadata.signed.delegations }),
    })
  );
  bumpedTargets.sign(await loadSigner(paths, root, "targets"));
  const targetsBytes = serialize(bumpedTargets);
  await writeAtomic(
    path.join(paths.metadata, `${bumpedTargets.signed.version}.targets.json`),
    targetsBytes
  );

  const storedName = `${digest}.${logical.at(-1)}`;
  const storedTarget = path.join(
    paths.targets,
    ...logical.slice(0, -1),
    storedName
  );
  await fs.mkdir(path.dirname(storedTarget), { recursive: true });
  await fs.copyFile(artifact, `${storedTarget}.tmp`);
  await fs.rename(`${storedTarget}.tmp`, storedTarget);

  const snapshotVersion = await currentVersion(paths.metadata, "snapshot");
  const snapshotJson = parseJson(
    await fs.readFile(
      path.join(paths.metadata, `${snapshotVersion}.snapshot.json`),
      "utf-8"
    )
  );
  const snapshotMetadata = Metadata.fromJSON(
    MetadataKind.Snapshot,
    snapshotJson
  );
  const bumpedSnapshot = new Metadata(
    new Snapshot({
      expires: expires(snapshotDays()),
      meta: {
        ...snapshotMetadata.signed.meta,
        "targets.json": metaFileFrom(
          bumpedTargets.signed.version,
          targetsBytes
        ),
      },
      specVersion: snapshotMetadata.signed.specVersion,
      version: snapshotMetadata.signed.version + 1,
    })
  );
  bumpedSnapshot.sign(await loadSigner(paths, root, "snapshot"));
  const snapshotBytes = serialize(bumpedSnapshot);
  await writeAtomic(
    path.join(paths.metadata, `${bumpedSnapshot.signed.version}.snapshot.json`),
    snapshotBytes
  );

  const timestampJson = parseJson(
    await fs.readFile(path.join(paths.metadata, "timestamp.json"), "utf-8")
  );
  const timestampMetadata = Metadata.fromJSON(
    MetadataKind.Timestamp,
    timestampJson
  );
  const bumpedTimestamp = new Metadata(
    new Timestamp({
      expires: expires(timestampDays()),
      snapshotMeta: metaFileFrom(bumpedSnapshot.signed.version, snapshotBytes),
      specVersion: timestampMetadata.signed.specVersion,
      version: timestampMetadata.signed.version + 1,
    })
  );
  bumpedTimestamp.sign(await loadSigner(paths, root, "timestamp"));
  await writeAtomic(
    path.join(paths.metadata, "timestamp.json"),
    serialize(bumpedTimestamp)
  );
  return targetPath;
};

/**
 * Re-sign snapshot and timestamp with fresh expiries, targets unchanged, so
 * client verification never meets an expired timestamp between releases.
 */
export const refreshMetadata = async (
  configuredRoot?: string
): Promise<void> => {
  const paths = updaterPaths(configuredRoot);
  const root = await loadRoot(paths);

  const targetsVersion = await currentVersion(paths.metadata, "targets");
  const targetsBytes = await fs.readFile(
    path.join(paths.metadata, `${targetsVersion}.targets.json`),
    "utf-8"
  );

  const snapshotVersion = await currentVersion(paths.metadata, "snapshot");
  const snapshotJson = parseJson(
    await fs.readFile(
      path.join(paths.metadata, `${snapshotVersion}.snapshot.json`),
      "utf-8"
    )
  );
  const snapshotMetadata = Metadata.fromJSON(
    MetadataKind.Snapshot,
    snapshotJson
  );
  const freshSnapshot = new Metadata(
    new Snapshot({
      expires: expires(snapshotDays()),
      meta: {
        ...snapshotMetadata.signed.meta,
        "targets.json": metaFileFrom(targetsVersion, targetsBytes),
      },
      specVersion: snapshotMetadata.signed.specVersion,
      version: snapshotMetadata.signed.version + 1,
    })
  );
  freshSnapshot.sign(await loadSigner(paths, root, "snapshot"));
  const snapshotBytes = serialize(freshSnapshot);
  await writeAtomic(
    path.join(paths.metadata, `${freshSnapshot.signed.version}.snapshot.json`),
    snapshotBytes
  );

  const timestampJson = parseJson(
    await fs.readFile(path.join(paths.metadata, "timestamp.json"), "utf-8")
  );
  const timestampMetadata = Metadata.fromJSON(
    MetadataKind.Timestamp,
    timestampJson
  );
  const freshTimestamp = new Metadata(
    new Timestamp({
      expires: expires(timestampDays()),
      snapshotMeta: metaFileFrom(freshSnapshot.signed.version, snapshotBytes),
      specVersion: timestampMetadata.signed.specVersion,
      version: timestampMetadata.signed.version + 1,
    })
  );
  freshTimestamp.sign(await loadSigner(paths, root, "timestamp"));
  await writeAtomic(
    path.join(paths.metadata, "timestamp.json"),
    serialize(freshTimestamp)
  );
};
