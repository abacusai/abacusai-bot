/**
 * The one move from the old stores into the memory folder, done once (a
 * marker file records it) and recorded in the history like any change, so it
 * can be undone. The old files are left where they were. Nothing here calls a
 * model: entries keep their words, and the agent files a note into a project
 * the first time it uses it.
 */
import fs from "fs";
import path from "path";

import { abacusBotDir } from "../config.js";
import { blankCard } from "./core.js";
import { MAX_NOTE_CHARS, looksSecret } from "./gate.js";
import {
  cardWrite,
  commit,
  type FileWrite,
  findProject,
  journalFile,
  memoryDir,
  newProjectSlug,
  type Note,
  type NoteType,
  noteWrite,
  type Project,
  type Scope,
  slugify,
  today,
} from "./notes.js";

const MARKER = ".migrated-v3";
const REPORT = ".migration-report.json";

export interface MigrationReport {
  at: string;
  moved: number;
  /** Entries left behind because they looked like passwords, keys or codes. */
  withheld: Array<{ from: string; preview: string }>;
}

const readOr = (file: string): string => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

const globalEntries = (file: string): string[] =>
  readOr(path.join(abacusBotDir(), "memories", file))
    .split("\n§\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const botEntries = (dir: string): string[] =>
  readOr(path.join(dir, "MEMORY.md"))
    .split("\n")
    .map((line) => /^- (.+)$/.exec(line.trim())?.[1]?.trim() ?? "")
    .filter((entry) => entry.length > 0);

const PREFERENCE =
  /\b(prefer|prefers|likes?|wants?|always|never|please|do not|don't|avoid|rather)\b/i;

const masked = (text: string): string =>
  `${text.slice(0, 12).replace(/\S/g, (char, at: number) => (at < 4 ? char : "•"))}…`;

export const migrationDone = (): boolean =>
  fs.existsSync(path.join(memoryDir(), MARKER));

export const readMigrationReport = (): MigrationReport | null => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(memoryDir(), REPORT), "utf8")
    ) as MigrationReport;
  } catch {
    return null;
  }
};

/**
 * Move the old stores in, once. `botName` names a bot by its id (the desktop
 * knows; elsewhere the id stands in). Safe to call from every process: the
 * marker is checked again under the lock.
 */
export const migrateOnce = async (
  botName: (id: string) => string = (id) => id,
  now = new Date()
): Promise<void> => {
  if (migrationDone()) return;
  await commit({ by: "app" }, () => {
    if (migrationDone()) return { writes: [], value: null };
    const writes: FileWrite[] = [];
    const report: MigrationReport = {
      at: now.toISOString(),
      moved: 0,
      withheld: [],
    };
    const taken = new Map<string, Set<string>>();

    const add = (scope: Scope, from: string, type: NoteType, text: string) => {
      if (looksSecret(text)) {
        report.withheld.push({ from, preview: masked(text) });
        return;
      }
      const key =
        scope.kind === "you"
          ? "you"
          : `${scope.kind}:${"slug" in scope ? scope.slug : ""}`;
      const names = taken.get(key) ?? new Set<string>();
      taken.set(key, names);
      const base = slugify(text.split(/\s+/).slice(0, 6).join(" "));
      let name = base;
      for (let n = 2; names.has(name); n += 1) name = `${base}-${n}`;
      names.add(name);
      const firstLine = text.split("\n")[0] ?? text;
      const note: Note = {
        scope,
        name,
        description: firstLine.slice(0, 150),
        type,
        body: text.slice(0, MAX_NOTE_CHARS * 2),
        updated: today(now),
        by: "app",
      };
      writes.push(noteWrite(note));
      report.moved += 1;
    };

    const you: Scope = { kind: "you" };
    for (const entry of globalEntries("REMEMBER.md"))
      add(you, "always remember", "rule", entry);
    for (const entry of globalEntries("USER.md"))
      add(
        you,
        "about you",
        PREFERENCE.test(entry) ? "preference" : "fact",
        entry
      );
    for (const entry of globalEntries("MEMORY.md"))
      add(you, "notes", "fact", entry);

    // Each bot becomes a project: its core entries as notes, its daily notes as journal lines.
    const botsDir = path.join(abacusBotDir(), "bots");
    let botIds: string[] = [];
    try {
      botIds = fs
        .readdirSync(botsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      // No bots yet.
    }
    const slugs = new Set<string>();
    for (const id of botIds) {
      const dir = path.join(botsDir, id);
      const entries = botEntries(dir);
      const notesDir = path.join(dir, "memory");
      let days: string[] = [];
      try {
        days = fs
          .readdirSync(notesDir)
          .filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file))
          .sort();
      } catch {
        // No daily notes.
      }
      if (entries.length === 0 && days.length === 0) continue;
      const ref = { kind: "bot" as const, key: id, name: botName(id) };
      let project: Project | null = findProject(id);
      if (project == null) {
        let slug = newProjectSlug(ref);
        for (let n = 2; slugs.has(slug); n += 1)
          slug = `${newProjectSlug(ref)}-${n}`;
        slugs.add(slug);
        project = { ...ref, slug };
        writes.push(cardWrite(project, blankCard(project, "app", now)));
      }
      const scope: Scope = { kind: "project", slug: project.slug };
      for (const entry of entries)
        add(
          scope,
          `bot ${ref.name}`,
          PREFERENCE.test(entry) ? "rule" : "fact",
          entry
        );
      const months = new Map<string, string[]>();
      for (const day of days) {
        const lines = readOr(path.join(notesDir, day))
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !looksSecret(line))
          .map(
            (line) => `- ${day.slice(0, 10)} · ${line.replace(/^[-*]\s*/, "")}`
          );
        const month = day.slice(0, 7);
        months.set(month, [...(months.get(month) ?? []), ...lines]);
      }
      for (const [month, lines] of months)
        writes.push({
          file: journalFile(scope, new Date(`${month}-15T12:00:00Z`)),
          contents: `${lines.join("\n")}\n`,
        });
    }

    writes.push({
      file: path.join(memoryDir(), REPORT),
      contents: JSON.stringify(report, null, 2),
    });
    writes.push({ file: path.join(memoryDir(), MARKER), contents: report.at });
    return { writes, value: null };
  });
};
