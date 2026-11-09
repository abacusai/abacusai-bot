/**
 * The memory folder: one Markdown file per note, grouped by scope, plus an
 * append-only history of every change. Everything that writes it goes through
 * `commit`, under one lock, so the history is complete and a change can be
 * undone. The history is a log of our own rather than git: most users have no
 * git binary.
 *
 *   memory/you/<name>.md                         about the owner, shared everywhere
 *   memory/projects/<slug>/PROJECT.md            a project's card
 *   memory/projects/<slug>/<name>.md             a project's notes
 *   memory/projects/<slug>/journal/YYYY-MM.md    dated lines; searched, never loaded
 *   memory/projects/<slug>/contacts/<who>/...    what a bot's sender chat may keep
 *   memory/.history/YYYY-MM.jsonl                every change, before and after
 */
import { createHash } from "crypto";
import fs from "fs";
import path from "path";

import { writeFileAtomicSync } from "../atomic-file.js";
import { abacusBotDir } from "../config.js";
import { withFileLock } from "./lock.js";

export const NOTE_TYPES = [
  "profile",
  "rule",
  "preference",
  "fact",
  "decision",
  "reference",
  "status",
] as const;

export type NoteType = (typeof NOTE_TYPES)[number] | "card";

/** Where a note lives. A contact is one sender of a bot, inside the bot's project. */
export type Scope =
  | { kind: "you" }
  | { kind: "project"; slug: string }
  | { kind: "contact"; slug: string; contact: string };

/** Who made a change; shown on the Memory page's history. */
export type Author = "you" | "chat" | "routine" | "bot" | "contact" | "app";

export interface Note {
  scope: Scope;
  name: string;
  description: string;
  type: NoteType;
  body: string;
  /** YYYY-MM-DD, stamped by the store. */
  updated: string;
  by: Author;
  /** The model that wrote it, when a model did. */
  model?: string;
  /** YYYY-MM-DD; only status notes carry one. */
  expires?: string;
}

/** A project card's binding: what in the app the project is. */
export interface ProjectRef {
  /** topic: ongoing work the user named in a chat, with no folder of its own. */
  kind: "folder" | "bot" | "routine" | "topic";
  /** Stable identity: the folder's path, the bot's id, the routine's id. */
  key: string;
  name: string;
  path?: string;
}

export interface Project extends ProjectRef {
  slug: string;
}

export interface HistoryEntry {
  at: string;
  by: Author;
  /** The process that made it, so a chat is not told about its own changes. */
  session: string;
  model?: string;
  /** Relative to the memory folder. */
  path: string;
  before: string | null;
  after: string | null;
}

export const CARD_NAME = "project";
const CARD_FILE = "PROJECT.md";
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const memoryDir = (): string => path.join(abacusBotDir(), "memory");
const historyDir = (): string => path.join(memoryDir(), ".history");
const lockPath = (): string => path.join(memoryDir(), ".lock");

export const isValidName = (name: string): boolean => NAME_PATTERN.test(name);

/** A file-safe name from free text: "Shop website!" -> "shop-website". */
export const slugify = (text: string, fallback = "note"): string => {
  const slug = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : fallback;
};

export const scopeDir = (scope: Scope): string => {
  if (scope.kind === "you") return path.join(memoryDir(), "you");
  const project = path.join(memoryDir(), "projects", scope.slug);
  return scope.kind === "project"
    ? project
    : path.join(project, "contacts", scope.contact);
};

const notePath = (scope: Scope, name: string): string =>
  scope.kind === "project" && name === CARD_NAME
    ? path.join(scopeDir(scope), CARD_FILE)
    : path.join(scopeDir(scope), `${name}.md`);

export const today = (now = new Date()): string =>
  now.toISOString().slice(0, 10);

// ── reading ────────────────────────────────────────────────────────────────

/** The header's `key: value` lines and the body after it. */
const splitHeader = (
  text: string
): { header: Record<string, string>; body: string } | null => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (match == null) return null;
  const header: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    header[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { header, body: text.slice(match[0].length).trim() };
};

const isNoteType = (value: string): value is NoteType =>
  value === "card" || (NOTE_TYPES as readonly string[]).includes(value);

const AUTHORS: readonly Author[] = [
  "you",
  "chat",
  "routine",
  "bot",
  "contact",
  "app",
];

/** A note file, or null when it is missing or not a note (hand-edited away). */
export const parseNote = (
  scope: Scope,
  name: string,
  text: string
): Note | null => {
  const split = splitHeader(text);
  if (split == null) return null;
  const { header, body } = split;
  const type = header.type ?? "";
  if (!isNoteType(type)) return null;
  const by = AUTHORS.find((author) => author === header.by) ?? "app";
  return {
    scope,
    name,
    description: header.description ?? "",
    type,
    body,
    updated: header.updated ?? "",
    by,
    ...(header.model ? { model: header.model } : {}),
    ...(header.expires ? { expires: header.expires } : {}),
  };
};

export const readNote = (scope: Scope, name: string): Note | null => {
  try {
    return parseNote(
      scope,
      name,
      fs.readFileSync(notePath(scope, name), "utf8")
    );
  } catch {
    // Missing is the normal answer to "is there a note called X".
    return null;
  }
};

/** Every note in one scope, card first, then by name. */
export const listNotes = (scope: Scope): Note[] => {
  let files: string[];
  try {
    files = fs.readdirSync(scopeDir(scope));
  } catch {
    return [];
  }
  const notes: Note[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".md")) continue;
    const name =
      file === CARD_FILE && scope.kind === "project"
        ? CARD_NAME
        : file.slice(0, -3);
    if (name !== CARD_NAME && !isValidName(name)) continue;
    const note = readNote(scope, name);
    if (note != null) notes.push(note);
  }
  return notes.sort((a, b) =>
    a.type === "card" ? -1 : b.type === "card" ? 1 : 0
  );
};

/** A project card's binding, kept in its header next to the note fields. */
const readBinding = (slug: string): ProjectRef | null => {
  try {
    const split = splitHeader(
      fs.readFileSync(
        path.join(memoryDir(), "projects", slug, CARD_FILE),
        "utf8"
      )
    );
    const header = split?.header;
    const kind = header?.kind;
    if (
      header == null ||
      (kind !== "folder" &&
        kind !== "bot" &&
        kind !== "routine" &&
        kind !== "topic") ||
      !header.key
    )
      return null;
    return {
      kind,
      key: header.key,
      name: header.project ?? slug,
      ...(header.path ? { path: header.path } : {}),
    };
  } catch {
    return null;
  }
};

export const listProjects = (): Project[] => {
  let slugs: string[];
  try {
    slugs = fs.readdirSync(path.join(memoryDir(), "projects"));
  } catch {
    return [];
  }
  return slugs
    .sort()
    .map((slug) => {
      const ref = readBinding(slug);
      return ref == null ? null : { ...ref, slug };
    })
    .filter((project): project is Project => project != null);
};

export const findProject = (key: string): Project | null =>
  listProjects().find((project) => project.key === key) ?? null;

// ── writing ────────────────────────────────────────────────────────────────

const serialize = (note: Note, binding?: ProjectRef): string => {
  const oneLine = (value: string) => value.replace(/\s*\r?\n\s*/g, " ").trim();
  const lines = [
    "---",
    `name: ${note.name}`,
    `description: ${oneLine(note.description)}`,
    `type: ${note.type}`,
    ...(note.expires ? [`expires: ${note.expires}`] : []),
    `updated: ${note.updated}`,
    `by: ${note.by}`,
    ...(note.model ? [`model: ${oneLine(note.model)}`] : []),
    ...(binding
      ? [
          `project: ${oneLine(binding.name)}`,
          `kind: ${binding.kind}`,
          `key: ${oneLine(binding.key)}`,
          ...(binding.path ? [`path: ${oneLine(binding.path)}`] : []),
        ]
      : []),
    "---",
    "",
    note.body.trim(),
    "",
  ];
  return lines.join("\n");
};

const relative = (file: string): string =>
  path.relative(memoryDir(), file).split(path.sep).join("/");

/** This process, as the history names it. */
export const SESSION_ID =
  process.env.ABACUSAI_BOT_SESSION_ID ?? `pid-${process.pid}`;

export interface Change {
  by: Author;
  model?: string;
}

/** One file's new contents, or null to delete it. */
export interface FileWrite {
  file: string;
  contents: string | null;
}

const readOrNull = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

const appendHistory = (entries: HistoryEntry[]): void => {
  if (entries.length === 0) return;
  fs.mkdirSync(historyDir(), { recursive: true });
  const month = entries[0]!.at.slice(0, 7);
  fs.appendFileSync(
    path.join(historyDir(), `${month}.jsonl`),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
  );
};

const BUSY =
  "Memory is being updated by another chat right now, so nothing was changed. Try again.";

/**
 * Apply writes atomically with respect to every other writer, and record each
 * in the history. `plan` runs under the lock and sees the folder as it is, so
 * its checks and its writes are one operation. It returns the writes plus a
 * value for the caller, or a string to refuse with.
 */
export const commit = async <T>(
  change: Change,
  plan: () => { writes: FileWrite[]; value: T } | string
): Promise<{ ok: true; value: T } | { ok: false; message: string }> => {
  const held = await withFileLock(lockPath(), () => {
    const planned = plan();
    if (typeof planned === "string") return planned;
    const at = new Date().toISOString();
    const entries: HistoryEntry[] = [];
    for (const { file, contents } of planned.writes) {
      const before = readOrNull(file);
      if (before === contents) continue;
      if (contents == null) fs.rmSync(file, { force: true });
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeFileAtomicSync(file, contents);
      }
      entries.push({
        at,
        by: change.by,
        session: SESSION_ID,
        ...(change.model ? { model: change.model } : {}),
        path: relative(file),
        before,
        after: contents,
      });
    }
    appendHistory(entries);
    return planned;
  });
  if (held == null) return { ok: false, message: BUSY };
  if (typeof held.value === "string") return { ok: false, message: held.value };
  return { ok: true, value: held.value.value };
};

export const noteWrite = (note: Note): FileWrite => ({
  file: notePath(note.scope, note.name),
  contents: serialize(note),
});

export const noteDelete = (scope: Scope, name: string): FileWrite => ({
  file: notePath(scope, name),
  contents: null,
});

/** The card with its binding: what the project is, written with the note. */
export const cardWrite = (project: Project, card: Note): FileWrite => ({
  file: notePath({ kind: "project", slug: project.slug }, CARD_NAME),
  contents: serialize(card, project),
});

export const journalFile = (scope: Scope, now = new Date()): string =>
  path.join(scopeDir(scope), "journal", `${today(now).slice(0, 7)}.md`);

/** The journal with one dated line added. */
export const journalAppend = (
  scope: Scope,
  line: string,
  now = new Date()
): FileWrite => {
  const file = journalFile(scope, now);
  const stamp = now.toISOString().slice(0, 16).replace("T", " ");
  const existing = readOrNull(file) ?? "";
  return {
    file,
    contents: `${existing}- ${stamp} · ${line.replace(/\s*\r?\n\s*/g, " ").trim()}\n`,
  };
};

/** Journal lines of one scope, newest month first. */
export const readJournal = (scope: Scope): string[] => {
  const dir = path.join(scopeDir(scope), "journal");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((file) => file.endsWith(".md"));
  } catch {
    return [];
  }
  return files
    .sort()
    .reverse()
    .flatMap((file) =>
      (readOrNull(path.join(dir, file)) ?? "")
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .reverse()
    );
};

/** A unique slug for a new project, stable for the same key. */
export const newProjectSlug = (ref: ProjectRef): string => {
  const base = slugify(ref.name, ref.kind);
  const taken = new Set(listProjects().map((project) => project.slug));
  if (!taken.has(base)) return base;
  const hash = createHash("sha1").update(ref.key).digest("hex").slice(0, 6);
  return `${base}-${hash}`;
};

// ── history ────────────────────────────────────────────────────────────────

/** Where the history ends now; changes after it are news to a running chat. */
export const historyCursor = (): string => {
  const months = historyMonths();
  const last = months[months.length - 1];
  if (last == null) return "";
  return `${last}:${fs.statSync(path.join(historyDir(), `${last}.jsonl`)).size}`;
};

const historyMonths = (): string[] => {
  try {
    return fs
      .readdirSync(historyDir())
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => file.slice(0, -6))
      .sort();
  } catch {
    return [];
  }
};

const readHistoryFile = (month: string, fromByte = 0): HistoryEntry[] => {
  try {
    const buffer = fs.readFileSync(path.join(historyDir(), `${month}.jsonl`));
    return buffer
      .subarray(fromByte)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as HistoryEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is HistoryEntry => entry != null);
  } catch {
    return [];
  }
};

/** Changes recorded after `cursor`, oldest first, and the new cursor. */
export const historySince = (
  cursor: string
): { entries: HistoryEntry[]; cursor: string } => {
  const [month = "", size = "0"] = cursor.split(":");
  const entries = historyMonths()
    .filter((each) => each >= month)
    .flatMap((each) =>
      readHistoryFile(each, each === month ? Number(size) || 0 : 0)
    );
  return { entries, cursor: historyCursor() };
};

/** The newest changes first, for the Memory page. */
export const recentHistory = (limit = 200): HistoryEntry[] =>
  historyMonths()
    .reverse()
    .flatMap((month) => readHistoryFile(month).reverse())
    .slice(0, limit);

/** The scope a history path belongs to, for filtering what a chat may see. */
export const scopeOfPath = (relativePath: string): Scope | null => {
  const parts = relativePath.split("/");
  if (parts[0] === "you") return { kind: "you" };
  if (parts[0] !== "projects" || parts[1] == null) return null;
  if (parts[2] === "contacts" && parts[3] != null)
    return { kind: "contact", slug: parts[1], contact: parts[3] };
  return { kind: "project", slug: parts[1] };
};

export const sameScope = (a: Scope, b: Scope): boolean =>
  a.kind === b.kind &&
  (a.kind === "you" ||
    (a.kind === "project" && b.kind === "project" && a.slug === b.slug) ||
    (a.kind === "contact" &&
      b.kind === "contact" &&
      a.slug === b.slug &&
      a.contact === b.contact));

/** The note a history path names, or null for journals and other files. */
export const noteNameOfPath = (relativePath: string): string | null => {
  const file = relativePath.split("/").pop() ?? "";
  if (relativePath.includes("/journal/")) return null;
  if (file === CARD_FILE) return CARD_NAME;
  return file.endsWith(".md") ? file.slice(0, -3) : null;
};

/** Absolute path of a history entry's file, for undo. */
export const absoluteOfHistory = (relativePath: string): string =>
  path.join(memoryDir(), ...relativePath.split("/"));

// ── which project a chat opened ────────────────────────────────────────────

const chatsFile = (): string => path.join(memoryDir(), ".chats.json");

const readChats = (): Record<string, string> => {
  try {
    const parsed = JSON.parse(fs.readFileSync(chatsFile(), "utf8")) as unknown;
    return parsed != null && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
};

/** The project a chat in the auto workspace opened, by its key; null when none. */
export const chatProjectKey = (session: string): string | null =>
  readChats()[session] ?? null;

/** The write that links (or, with null, unlinks) a chat and a project. */
export const chatProjectWrite = (
  session: string,
  key: string | null
): FileWrite => {
  const chats = readChats();
  if (key == null) delete chats[session];
  else chats[session] = key;
  return { file: chatsFile(), contents: `${JSON.stringify(chats, null, 2)}\n` };
};
