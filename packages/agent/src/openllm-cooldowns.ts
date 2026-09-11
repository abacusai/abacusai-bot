/**
 * Where the OpenLLM router's cooldowns live between sessions. Every chat is
 * its own agent process, so without this each new chat rediscovers the
 * saturated models at the front of the pool. The file is advisory: a lost
 * write costs one retry of one model and heals on the next failure, so it is
 * best-effort throughout.
 */
import fs from "fs";
import path from "path";

import { abacusBotDir } from "./config.js";

/** One model's standing with the router. */
export interface CooldownEntry {
  /** When the model may be picked again, ms since epoch. */
  until: number;
  /** Consecutive failures, which is what lengthens the next wait. */
  failures: number;
}

export type CooldownEntries = Record<string, CooldownEntry>;

export interface CooldownStore {
  read(): CooldownEntries;
  write(entries: CooldownEntries): void;
}

const STORE_FILE = "openllm-cooldowns.json";

const isEntry = (value: unknown): value is CooldownEntry =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as CooldownEntry).until === "number" &&
  typeof (value as CooldownEntry).failures === "number";

/** Drop what has expired, so the file stays the size of the live problem. */
const live = (entries: CooldownEntries, now: number): CooldownEntries =>
  Object.fromEntries(
    Object.entries(entries).filter(([, entry]) => entry.until > now)
  );

/**
 * Merge two views of the same file, keeping the more pessimistic one. Sessions
 * rewrite the whole file concurrently, so last-writer-wins could resurrect a
 * model another session just found dead; this can only ever cost a retry.
 */
const merge = (a: CooldownEntries, b: CooldownEntries): CooldownEntries => {
  const merged: CooldownEntries = { ...a };

  for (const [id, entry] of Object.entries(b)) {
    const existing = merged[id];

    merged[id] =
      existing == null
        ? entry
        : {
            until: Math.max(existing.until, entry.until),
            failures: Math.max(existing.failures, entry.failures),
          };
  }

  return merged;
};

/** The store the agent actually uses, rooted in the agent's home directory. */
export function fileCooldownStore(
  now: () => number = Date.now,
  file: string = path.join(abacusBotDir(), STORE_FILE)
): CooldownStore {
  const read = (): CooldownEntries => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));

      if (typeof parsed !== "object" || parsed === null) return {};

      return live(
        Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(
            (pair): pair is [string, CooldownEntry] => isEntry(pair[1])
          )
        ),
        now()
      );
    } catch {
      // No file yet, or one this version cannot read: start from nothing.
      return {};
    }
  };

  return {
    read,
    write(entries: CooldownEntries): void {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });

        const merged = live(merge(read(), entries), now());
        // Write beside the target and rename, so a reader never sees a half
        // written file and a crash mid-write leaves the old one intact.
        const temporary = `${file}.${process.pid}.tmp`;

        fs.writeFileSync(temporary, JSON.stringify(merged), "utf8");
        fs.renameSync(temporary, file);
      } catch {
        // Losing a cooldown costs one retry of one model. Not worth a message.
      }
    },
  };
}
