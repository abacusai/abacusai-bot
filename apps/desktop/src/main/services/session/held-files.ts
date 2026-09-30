/**
 * Writes and removals of files an unresolved migration commit may cover
 * (`isMigrationWriteBlocked`, spec 00 C.1), made durable without touching
 * the held file: each is journalled to `threads/.pending/<hash>.json` (the
 * whole new content, or a removal) and replayed onto the destination the
 * first time the destination is used after the block lifts, normally on the
 * next launch after recovery settles. Until then every read of the
 * destination sees the journalled state, so a conversation saved while
 * recovery is unresolved is not lost at quit.
 *
 * If the journal itself is held (an attempt whose destinations are unknown
 * holds every file), the change is kept in memory for this launch only, and
 * that is logged: nothing may be written anywhere under the home then.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type Change = { op: "write"; text: string } | { op: "remove" };

interface JournalEntry {
  version: 1;
  dest: string;
  op: "write" | "remove";
  text?: string;
}

export type HeldRead =
  | { status: "ok"; text: string }
  | { status: "missing" }
  | { status: "unreadable"; error: string }
  | { status: "tooLarge"; size: number };

const isMissingError = (error: unknown): boolean =>
  (error as { code?: unknown })?.code === "ENOENT" ||
  (error as { code?: unknown })?.code === "ENOTDIR";

export interface HeldFilesOptions {
  /** The journal folder (`<home>/threads/.pending`), read on every call. */
  dir: () => string;
  isWriteBlocked: (file: string) => boolean;
  writeFile: (file: string, text: string) => void;
  log: (message: string) => void;
}

export class HeldFiles {
  private readonly options: HeldFilesOptions;
  /** Fallback when the journal itself is held. */
  private readonly memory = new Map<string, Change>();

  constructor(options: HeldFilesOptions) {
    this.options = options;
  }

  isBlocked(file: string): boolean {
    return this.options.isWriteBlocked(file);
  }

  /** Writes `text` to `file`, or journals it while `file` is held. */
  write(file: string, text: string): "written" | "held" {
    this.replay(file);
    if (!this.isBlocked(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.options.writeFile(file, text);
      this.forget(file);
      return "written";
    }
    this.hold(file, { op: "write", text });
    return "held";
  }

  /** Removes `file`, or journals the removal while it is held. */
  remove(file: string): "removed" | "held" {
    this.replay(file);
    if (!this.isBlocked(file)) {
      fs.rmSync(file, { force: true });
      this.forget(file);
      return "removed";
    }
    this.hold(file, { op: "remove" });
    return "held";
  }

  /** The held change for `file`, if any (after replaying what it can). */
  pending(file: string): Change | null {
    this.replay(file);
    return this.memory.get(path.resolve(file)) ?? this.readJournal(file);
  }

  /** `file` as this launch sees it: a held change, else the disk. */
  read(file: string, maxBytes = Number.POSITIVE_INFINITY): HeldRead {
    const change = this.pending(file);
    if (change !== null) {
      if (change.op === "remove") return { status: "missing" };
      const size = Buffer.byteLength(change.text);
      return size > maxBytes
        ? { status: "tooLarge", size }
        : { status: "ok", text: change.text };
    }
    try {
      if (Number.isFinite(maxBytes)) {
        const { size } = fs.statSync(file);
        if (size > maxBytes) return { status: "tooLarge", size };
      }
      return { status: "ok", text: fs.readFileSync(file, "utf8") };
    } catch (error) {
      return isMissingError(error)
        ? { status: "missing" }
        : { status: "unreadable", error: String(error) };
    }
  }

  exists(file: string): boolean {
    const change = this.pending(file);
    if (change !== null) return change.op === "write";
    return fs.existsSync(file);
  }

  /** Applies every journalled change whose destination is no longer held. */
  replayAll(): number {
    let applied = 0;
    for (const entry of this.journalEntries())
      if (this.replay(entry.dest)) applied += 1;
    return applied;
  }

  private journalPath(file: string): string {
    const hash = createHash("sha256")
      .update(path.resolve(file))
      .digest("base64url")
      .slice(0, 32);
    return path.join(this.options.dir(), `${hash}.json`);
  }

  private hold(file: string, change: Change): void {
    const key = path.resolve(file);
    const journal = this.journalPath(file);
    if (!this.isBlocked(journal)) {
      const entry: JournalEntry = {
        version: 1,
        dest: key,
        ...change,
      };
      try {
        fs.mkdirSync(path.dirname(journal), { recursive: true });
        this.options.writeFile(journal, JSON.stringify(entry));
        this.memory.delete(key);
        return;
      } catch (error) {
        this.options.log(
          `cannot journal the held change to ${path.basename(file)}: ${String(error)}; kept in memory`
        );
      }
    } else {
      this.options.log(
        `${path.basename(file)} and its journal are held; the change is kept in memory for this launch only`
      );
    }
    this.memory.set(key, change);
  }

  private forget(file: string): void {
    this.memory.delete(path.resolve(file));
    const journal = this.journalPath(file);
    if (!this.isBlocked(journal)) fs.rmSync(journal, { force: true });
  }

  private readJournal(file: string): Change | null {
    let text: string;
    try {
      text = fs.readFileSync(this.journalPath(file), "utf8");
    } catch {
      return null;
    }
    try {
      const entry = JSON.parse(text) as JournalEntry;
      if (entry.dest !== path.resolve(file)) return null;
      if (entry.op === "remove") return { op: "remove" };
      if (entry.op === "write" && typeof entry.text === "string")
        return { op: "write", text: entry.text };
    } catch {
      // A torn journal entry (the atomic writer makes this unlikely): the
      // destination stays as it is.
    }
    return null;
  }

  private journalEntries(): JournalEntry[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.options.dir());
    } catch {
      return [];
    }
    return names.flatMap((name) => {
      try {
        const entry = JSON.parse(
          fs.readFileSync(path.join(this.options.dir(), name), "utf8")
        ) as JournalEntry;
        return typeof entry.dest === "string" ? [entry] : [];
      } catch {
        return [];
      }
    });
  }

  /** Applies `file`'s journalled change once it is no longer held. */
  private replay(file: string): boolean {
    if (this.isBlocked(file)) return false;
    const key = path.resolve(file);
    const change = this.memory.get(key) ?? this.readJournal(file);
    if (change === null) return false;
    try {
      if (change.op === "write") {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        this.options.writeFile(file, change.text);
      } else fs.rmSync(file, { force: true });
    } catch (error) {
      this.options.log(
        `replaying the held change to ${path.basename(file)} failed: ${String(error)}`
      );
      return false;
    }
    this.memory.delete(key);
    const journal = this.journalPath(file);
    if (!this.isBlocked(journal)) fs.rmSync(journal, { force: true });
    return true;
  }
}
