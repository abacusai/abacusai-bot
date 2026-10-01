import { randomUUID } from "node:crypto";
/** Digest-checked rollback from completed migration evidence, independently per profile. */
import fs from "node:fs";
import path from "node:path";

import {
  readArchiveIndexStrict,
  ARCHIVE_INDEX_NAME,
} from "../services/session/thread-store";
import { rebuildRestoreIndex } from "./attempt-records";
import {
  backupsRoot,
  formatStamp,
  sha256File,
  nodeIo,
  inside,
  writeFileAtomic,
} from "./backup";
import { readRecordState, writeRecord } from "./record";
import { runMigrations } from "./runner";
interface Generation {
  generation: string;
  at: string;
  consumed: string[];
  destinations: string[];
}
export interface RestoreResult {
  home: string;
  restored: string[];
  collisions: string[];
  skipped: string[];
}
const safePath = (root: string, relative: string): string => {
  const file = path.resolve(root, relative);
  if (inside(root, file) === null)
    throw new Error(`Restore path outside root: ${relative}`);
  return file;
};
export const profileHomes = (base: string): string[] => {
  const homes = new Set([path.resolve(base)]);
  const file = path.join(base, "profiles.json");
  if (fs.existsSync(file)) {
    const registry = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const value of Object.values(registry.profiles ?? {})) {
      if (typeof value !== "string") throw new Error("Invalid profile path");
      const home = path.resolve(base, value);
      if (home !== path.resolve(base) && inside(base, home) === null)
        throw new Error("Profile outside base");
      homes.add(home);
    }
  }
  for (const home of homes) {
    let current = home;
    while (current !== path.dirname(path.resolve(base))) {
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
        throw new Error(`Symlink in profile path: ${current}`);
      current = path.dirname(current);
    }
  }
  return [...homes];
};
export const restoreLegacyHome = async (
  home: string,
  now = new Date()
): Promise<RestoreResult> => {
  const userData = path.join(home, "electron");
  // Finish or undo an interrupted commit before reading its completion evidence.
  const recovery = await runMigrations({
    home,
    userData,
    steps: [],
    appVersion: "restore",
    log: () => {},
  });
  if (recovery.failed || recovery.unresolved.length)
    throw new Error(`Unresolved migration in ${home}`);
  const recordState = readRecordState(home);
  if (recordState.status !== "ok" && recordState.status !== "missing")
    throw new Error(
      `Cannot restore with ${recordState.status} migration record`
    );
  const entries = rebuildRestoreIndex(home);
  const journal = path.join(backupsRoot(home), "restorations.jsonl");
  const generations: Generation[] = fs.existsSync(journal)
    ? fs
        .readFileSync(journal, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  for (const g of generations)
    if (
      typeof g.generation !== "string" ||
      !Array.isArray(g.consumed) ||
      !g.consumed.every((id) => typeof id === "string") ||
      !Array.isArray(g.destinations) ||
      !g.destinations.every((dest) => typeof dest === "string")
    )
      throw new Error("Invalid restoration journal");
  const latest = new Map<string, (typeof entries)[number]>();
  const allByDestination = new Map<string, typeof entries>();
  for (const entry of entries) {
    if (![3, 4].includes(entry.step) || !entry.backup || !entry.originalSha256)
      continue;
    const destination = safePath(
      entry.root === "home" ? home : userData,
      entry.source
    );
    if (destination === path.join(home, "prefs.json")) continue;
    if (
      entry.op !== "remove" &&
      !(
        entry.op === "replace" &&
        destination === path.join(userData, "renderer-state.json")
      )
    )
      continue;
    if (entry.roots.home !== home || entry.roots.userData !== userData)
      throw new Error("Restore roots differ from profile");
    const consumed = new Set(
      generations
        .filter((g) => g.destinations.includes(destination))
        .flatMap((g) => g.consumed)
    );
    if (consumed.has(entry.attempt)) continue;
    const list = allByDestination.get(destination) ?? [];
    list.push(entry);
    allByDestination.set(destination, list);
    const previous = latest.get(destination);
    if (
      !previous ||
      entry.stamp > previous.stamp ||
      (entry.stamp === previous.stamp && entry.attempt > previous.attempt)
    )
      latest.set(destination, entry);
  }
  const result: RestoreResult = {
    home,
    restored: [],
    collisions: [],
    skipped: [],
  };
  const consumed = new Set<string>();
  const destinations: string[] = [];
  const index = readArchiveIndexStrict(path.join(home, "threads"));
  for (const [destination, entry] of latest) {
    const backup = safePath(
      path.join(backupsRoot(home), entry.directory),
      entry.backup!
    );
    try {
      if (sha256File(backup, nodeIo) !== entry.originalSha256) {
        result.skipped.push(`${destination}: backup digest mismatch`);
        continue;
      }
    } catch (error) {
      result.skipped.push(`${destination}: ${String(error)}`);
      continue;
    }
    // Reject symlinks along either path. No restore may follow a profile link outside its home.
    for (const file of [destination, backup]) {
      let current = file;
      while (inside(home, current) !== null) {
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
          throw new Error(`Symlink in restore path: ${current}`);
        current = path.dirname(current);
      }
    }
    const current = fs.existsSync(destination)
      ? sha256File(destination, nodeIo)
      : null;
    let target = destination;
    if (
      current !== null &&
      current !== entry.originalSha256 &&
      current !== entry.resultSha256
    ) {
      const parsed = path.parse(destination);
      target = path.join(
        parsed.dir,
        `${parsed.name}.restored-${formatStamp(now)}-${entry.attempt}${parsed.ext}`
      );
      if (
        fs.existsSync(target) &&
        sha256File(target, nodeIo) !== entry.originalSha256
      )
        throw new Error(`Restore collision already exists: ${target}`);
      result.collisions.push(target);
    }
    if (current !== entry.originalSha256 || target !== destination) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeFileAtomic(target, fs.readFileSync(backup), nodeIo);
    }
    // Keep backup evidence for the rollback window and retry after interrupted metadata writes.
    result.restored.push(target);
    if (target !== destination) continue;
    destinations.push(destination);
    for (const op of allByDestination.get(destination) ?? [])
      consumed.add(op.attempt);
    if (
      destination.startsWith(path.join(home, "transcripts") + path.sep) ||
      destination.startsWith(path.join(home, "threads") + path.sep)
    )
      delete index.archived[
        path.basename(destination).replace(/\.(json|cleared)$/, "")
      ];
    if (destination === path.join(userData, "renderer-state.json"))
      fs.rmSync(path.join(userData, "renderer-state.retired.json"), {
        force: true,
      });
  }
  if (destinations.length) {
    writeFileAtomic(
      path.join(home, "threads", ARCHIVE_INDEX_NAME),
      JSON.stringify(index),
      nodeIo
    );
    const record = recordState.record;
    record.applied = record.applied.map((entry) =>
      [3, 4].includes(entry.id) &&
      ![...latest].some(
        ([destination, op]) =>
          op.step === entry.id && !destinations.includes(destination)
      )
        ? { ...entry, restoredAt: now.toISOString() }
        : entry
    );
    record.partial = record.partial?.filter(
      (entry) =>
        ![3, 4].includes(entry.id) ||
        [...latest].some(
          ([destination, op]) =>
            op.step === entry.id && !destinations.includes(destination)
        )
    );
    writeRecord(home, record);
    const generation: Generation = {
      generation: randomUUID(),
      at: now.toISOString(),
      consumed: [...consumed],
      destinations,
    };
    writeFileAtomic(
      journal,
      generations.map((g) => JSON.stringify(g) + "\n").join("") +
        JSON.stringify(generation) +
        "\n",
      nodeIo
    );
  }
  return result;
};
export const restoreLegacyFiles = async (
  base: string
): Promise<RestoreResult[]> => {
  const results: RestoreResult[] = [];
  for (const home of profileHomes(base))
    results.push(await restoreLegacyHome(home));
  return results;
};
