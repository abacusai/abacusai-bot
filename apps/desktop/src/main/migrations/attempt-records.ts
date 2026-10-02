/** Retained commit evidence. The JSONL index is a rebuildable cache, never evidence. */
import { createHash } from "node:crypto";
import path from "node:path";

import * as v from "valibot";

import {
  backupsRoot,
  backupDirName,
  inside,
  isAbsentError,
  nodeIo,
  parseStamp,
  sha256File,
  writeFileAtomic,
  type MigrationIo,
} from "./backup";
import type { CommitJournal } from "./journal";
import { readRecordState } from "./record";

const digest = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const relative = v.pipe(
  v.string(),
  v.check(
    (s) =>
      s !== "" &&
      !path.isAbsolute(s) &&
      s === path.normalize(s) &&
      s !== ".." &&
      !s.startsWith(`..${path.sep}`)
  )
);
const OperationSchema = v.strictObject({
  op: v.picklist(["remove", "replace", "create"]),
  root: v.picklist(["home", "userData"]),
  source: relative,
  backup: v.optional(relative),
  originalSha256: v.optional(digest),
  resultSha256: v.optional(digest),
});
const ManifestSchema = v.strictObject({
  version: v.literal(1),
  attempt: v.pipe(v.string(), v.regex(/^[a-f0-9]{16,64}$/)),
  step: v.pipe(v.number(), v.integer(), v.minValue(1)),
  name: v.pipe(v.string(), v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)),
  stamp: v.pipe(
    v.string(),
    v.check((s) => parseStamp(s) !== null)
  ),
  roots: v.strictObject({ home: v.string(), userData: v.string() }),
  ops: v.array(OperationSchema),
});
const CompletionSchema = v.strictObject({
  attempt: v.string(),
  recordedAt: v.string(),
  partial: v.boolean(),
  manifestSha256: digest,
});
export type AttemptManifest = v.InferOutput<typeof ManifestSchema>;
export type AttemptOperation = v.InferOutput<typeof OperationSchema>;
export interface CompletedAttempt {
  directory: string;
  manifest: AttemptManifest;
  completed: v.InferOutput<typeof CompletionSchema>;
}
export interface RestoreIndexEntry extends AttemptOperation {
  attempt: string;
  step: number;
  stamp: string;
  directory: string;
  roots: AttemptManifest["roots"];
}
const hash = (text: string | Buffer): string =>
  createHash("sha256").update(text).digest("hex");

export const writeAttemptManifest = (
  journal: CommitJournal,
  roots: AttemptManifest["roots"],
  io: MigrationIo = nodeIo
): void => {
  const location = (
    file: string
  ): Pick<AttemptOperation, "root" | "source"> => {
    const home = inside(roots.home, file);
    if (home !== null) return { root: "home", source: home };
    const userData = inside(roots.userData, file);
    if (userData !== null) return { root: "userData", source: userData };
    throw new Error(`Attempt destination outside recorded roots: ${file}`);
  };
  const manifest: AttemptManifest = {
    version: 1,
    attempt: journal.attempt,
    step: journal.id,
    name: journal.name,
    stamp: journal.commit,
    roots,
    ops: [
      ...journal.writes.map((write): AttemptOperation => ({
        op: write.kind === "create" ? "create" : "replace",
        ...location(write.dest),
        ...(write.backup === null
          ? {}
          : {
              backup: path.relative(journal.backupDir, write.backup),
              originalSha256: write.originalHash ?? undefined,
            }),
        resultSha256: sha256File(write.staged, io),
      })),
      ...journal.removals.map((removal): AttemptOperation => ({
        op: "remove",
        ...location(removal.path),
        backup: path.relative(journal.backupDir, removal.backup),
        originalSha256: sha256File(removal.path, io),
      })),
    ],
  };
  v.parse(ManifestSchema, manifest);
  writeFileAtomic(
    path.join(journal.backupDir, "attempt.json"),
    JSON.stringify(manifest),
    io
  );
};

/** Written only once migrations.json proves this attempt committed. */
export const completeAttempt = (
  directory: string,
  attempt: string,
  partial: boolean,
  recordedAt: string,
  io: MigrationIo = nodeIo
): void => {
  const bytes = io.readFileSync(path.join(directory, "attempt.json"));
  const manifest = v.parse(ManifestSchema, JSON.parse(bytes.toString("utf8")));
  if (manifest.attempt !== attempt)
    throw new Error("Attempt identity mismatch");
  writeFileAtomic(
    path.join(directory, "completed.json"),
    JSON.stringify({
      attempt,
      recordedAt,
      partial,
      manifestSha256: hash(bytes),
    }),
    io
  );
};

export const completedAttempts = (
  home: string,
  io: MigrationIo = nodeIo,
  log: (message: string) => void = console.warn
): CompletedAttempt[] => {
  let names: string[];
  try {
    names = io.readdirSync(backupsRoot(home));
  } catch (error) {
    if (isAbsentError(error)) return [];
    throw error;
  }
  const attempts: CompletedAttempt[] = [];
  for (const name of names.sort()) {
    const directory = path.join(backupsRoot(home), name);
    if (!io.lstatSync(directory).isDirectory() || name.startsWith(".pruning-"))
      continue;
    try {
      const completed = v.parse(
        CompletionSchema,
        JSON.parse(
          io
            .readFileSync(path.join(directory, "completed.json"))
            .toString("utf8")
        )
      );
      const bytes = io.readFileSync(path.join(directory, "attempt.json"));
      if (hash(bytes) !== completed.manifestSha256)
        throw new Error("Manifest digest mismatch");
      const manifest = v.parse(
        ManifestSchema,
        JSON.parse(bytes.toString("utf8"))
      );
      if (
        manifest.attempt !== completed.attempt ||
        manifest.roots.home !== home ||
        name !==
          backupDirName(
            manifest.stamp,
            manifest.step,
            manifest.name,
            manifest.attempt
          )
      )
        throw new Error("Manifest roots or identity mismatch");
      if (!path.isAbsolute(manifest.roots.userData))
        throw new Error("Invalid userData root");
      for (const op of manifest.ops) {
        if (
          op.op === "remove" &&
          (op.backup === undefined || op.originalSha256 === undefined)
        )
          throw new Error("Removal without backup evidence");
        if (op.backup !== undefined && op.originalSha256 === undefined)
          throw new Error("Backup without digest");
      }
      attempts.push({ directory, manifest, completed });
    } catch (error) {
      if (!isAbsentError(error))
        log(`[migrations] excluded ${name}: ${String(error)}`);
    }
  }
  return attempts;
};

export const rebuildRestoreIndex = (
  home: string,
  io: MigrationIo = nodeIo,
  log?: (message: string) => void
): RestoreIndexEntry[] => {
  const attempts = completedAttempts(home, io, log);
  const state = readRecordState(home, io);
  if (state.status === "ok") {
    const required = [
      ...state.record.applied.filter((entry) => !entry.restoredAt),
      ...(state.record.partial ?? []),
    ].filter((entry) => [3, 4].includes(entry.id) && entry.attempt);
    for (const entry of required)
      if (
        !attempts.some(
          ({ manifest }) =>
            manifest.attempt === entry.attempt && manifest.step === entry.id
        )
      )
        throw new Error(
          `Missing or invalid restore evidence for step ${entry.id}, attempt ${entry.attempt}`
        );
  }
  const entries = attempts.flatMap(({ directory, manifest }) =>
    manifest.ops.map((op) => ({
      ...op,
      directory: path.basename(directory),
      attempt: manifest.attempt,
      step: manifest.step,
      stamp: manifest.stamp,
      roots: manifest.roots,
    }))
  );
  const file = path.join(backupsRoot(home), "restore-index.jsonl");
  const text = entries.map((entry) => JSON.stringify(entry) + "\n").join("");
  let previous: string | null = null;
  try {
    previous = io.readFileSync(file).toString("utf8");
  } catch (error) {
    if (!isAbsentError(error)) throw error;
  }
  if (previous !== text) writeFileAtomic(file, text, io);
  return entries;
};
