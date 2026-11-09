/**
 * The Memory page's side of the memory folder (packages/agent/src/memory):
 * its rows, projects, history, undo and the user's own edits. Every write
 * goes through the folder's `commit`, so it lands in the history like the
 * agent's own, and the page's watcher hears it the same way.
 */
import fs from "node:fs";
import path from "node:path";

import {
  absoluteOfHistory,
  blankCard,
  CARD_NAME,
  cardWrite,
  chatProjectKey,
  checkDraft,
  commit,
  ensureProject,
  type FileWrite,
  findProject,
  type HistoryEntry,
  isValidName,
  journalAppend,
  listNotes,
  listProjects,
  memoryDir,
  migrateOnce,
  type Note,
  noteDelete,
  noteNameOfPath,
  type NoteType,
  noteWrite,
  parseNote,
  type Project,
  readMigrationReport,
  readNote,
  recentHistory,
  type Scope,
  scopeDir,
  scopeOfPath,
  slugify,
  today,
} from "@abacus-ai/agent/memory";
import { ConflictError } from "@abacus-ai/contract/conflict";
import type { MemoryRow } from "@abacus-ai/contract/contract/rows";
import type {
  MemoryChangeView,
  MemoryProjectView,
  MemoryWithheldView,
} from "@abacus-ai/contract/contracts";
import { InvalidInputError } from "@abacus-ai/contract/service-errors";

/** What the page shows of the history. */
const HISTORY_SHOWN = 50;
/** How far back an undo or the page looks, past entries it filters out. */
const HISTORY_SCAN = 400;

export const CHANGED_SINCE =
  "That note has changed since; undo the later change first.";

// ── rows ───────────────────────────────────────────────────────────────────

/** The store's own path for a note (a delete's target is the note's file). */
const fileOf = (scope: Scope, name: string): string =>
  noteDelete(scope, name).file;

const relativeOf = (file: string): string =>
  path.relative(memoryDir(), file).split(path.sep).join("/");

const contactsOf = (slug: string): string[] => {
  try {
    return fs
      .readdirSync(path.join(scopeDir({ kind: "project", slug }), "contacts"), {
        withFileTypes: true,
      })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    // No contacts: not a bot's project, or nobody has written yet.
    return [];
  }
};

const rowOf = (note: Note): MemoryRow => ({
  id: relativeOf(fileOf(note.scope, note.name)),
  scope: note.scope.kind,
  project: note.scope.kind === "you" ? null : note.scope.slug,
  contact: note.scope.kind === "contact" ? note.scope.contact : null,
  name: note.name,
  description: note.description,
  type: note.type,
  body: note.body,
  updated: note.updated,
  by: note.by,
  model: note.model ?? null,
  expires: note.expires ?? null,
});

/** Every note: about you, then each project's notes and its contacts'. */
export const memoryRows = (): MemoryRow[] => {
  const scopes: Scope[] = [{ kind: "you" }];
  for (const { slug } of listProjects()) {
    scopes.push({ kind: "project", slug });
    for (const contact of contactsOf(slug))
      scopes.push({ kind: "contact", slug, contact });
  }
  return scopes.flatMap((scope) => listNotes(scope).map(rowOf));
};

const projectView = (project: Project): MemoryProjectView => ({
  slug: project.slug,
  name: project.name,
  kind: project.kind,
  key: project.key,
  path: project.path ?? null,
});

export const memoryProjects = (): MemoryProjectView[] =>
  listProjects().map(projectView);

/**
 * A chat's project: the one its memory env declares (its folder, its bot),
 * else the one it opened (`memory/.chats.json`), as lanes.ts resolves it.
 */
export const chatProject = (
  declaredKey: string | null,
  sessionId: string
): MemoryProjectView | null => {
  const key = declaredKey ?? chatProjectKey(sessionId);
  const project = key == null ? null : findProject(key);
  return project == null ? null : projectView(project);
};

/** A path the page sent, as a file that must stay inside the memory folder. */
const insideMemory = (relativePath: string): string => {
  const file = absoluteOfHistory(relativePath);
  const rel = path.relative(memoryDir(), file);
  if (
    relativePath.includes("\\") ||
    rel.length === 0 ||
    rel.startsWith("..") ||
    path.isAbsolute(rel)
  )
    throw new InvalidInputError("That is not a file in memory.");
  return file;
};

/** A row's id back to its note; only the store's own paths are accepted. */
const noteOfId = (id: string): { scope: Scope; name: string } => {
  const file = insideMemory(id);
  const scope = scopeOfPath(id);
  const name = noteNameOfPath(id);
  if (scope == null || name == null || fileOf(scope, name) !== file)
    throw new InvalidInputError("That is not a note.");
  return { scope, name };
};

const settled = <T>(
  result: { ok: true; value: T } | { ok: false; message: string }
): T => {
  if ("message" in result) throw new ConflictError(result.message);
  return result.value;
};

// ── the user's edits ───────────────────────────────────────────────────────

export const forgetNote = async (id: string): Promise<void> => {
  const { scope, name } = noteOfId(id);
  settled(
    await commit({ by: "you" }, () => {
      const note = readNote(scope, name);
      // Already gone is what the user wanted.
      if (note == null) return { writes: [], value: null };
      if (note.type === "card")
        throw new InvalidInputError(
          "A project's card cannot be forgotten; edit it or clear the project."
        );
      return { writes: [noteDelete(scope, name)], value: null };
    })
  );
};

export type MemorySaveInput = (
  | { scope: "you" }
  | { scope: "project"; project: string }
) & {
  name?: string;
  type: NoteType;
  text: string;
  description?: string;
  expires?: string;
};

const projectOf = (slug: string): Project => {
  const project = listProjects().find((each) => each.slug === slug);
  if (project == null) throw new InvalidInputError("That project is gone.");
  return project;
};

const freshName = (text: string, taken: readonly Note[]): string => {
  const base = slugify(text.split(/\s+/).slice(0, 6).join(" "));
  const names = new Set(taken.map((note) => note.name));
  let name = base;
  for (let n = 2; names.has(name); n += 1) name = `${base}-${n}`;
  return name;
};

/**
 * Creates a note, or updates the one named. The gate's checks apply as to
 * the agent's writes, except the claim checks: these are the user's words.
 */
export const saveNote = async (
  input: MemorySaveInput,
  now = new Date()
): Promise<MemoryRow> => {
  const project = input.scope === "project" ? projectOf(input.project) : null;
  const scope: Scope =
    project != null ? { kind: "project", slug: project.slug } : { kind: "you" };
  if (
    input.name != null &&
    !isValidName(input.name) &&
    input.name !== CARD_NAME
  )
    throw new InvalidInputError("That is not a note's name.");
  const note = settled(
    await commit({ by: "you" }, () => {
      const siblings = listNotes(scope);
      const current =
        input.name == null
          ? null
          : (siblings.find((each) => each.name === input.name) ?? null);
      // A card stays a card: it carries the project's binding.
      if ((current?.type === "card") !== (input.type === "card"))
        throw new InvalidInputError("A project card is only edited in place.");
      const text = input.text.trim();
      const name =
        current?.name ??
        input.name ??
        freshName(input.description || text, siblings);
      const expires = input.expires ?? current?.expires;
      const draft = checkDraft({
        draft: {
          name,
          // An edited text gets a description of its own words.
          description:
            input.description ??
            (current != null && current.body === text
              ? current.description
              : ""),
          type: input.type,
          body: text,
          ...(expires != null ? { expires } : {}),
        },
        siblings,
        updating: current?.name ?? null,
        userWords: "",
        byUser: true,
        now,
      });
      if (typeof draft === "string") throw new InvalidInputError(draft);
      const saved: Note = { scope, ...draft, updated: today(now), by: "you" };
      return {
        writes: [
          saved.type === "card" && project != null
            ? cardWrite(project, saved)
            : noteWrite(saved),
        ],
        value: saved,
      };
    })
  );
  return rowOf(note);
};

/** Forget every note of the scope; a project's card goes back to blank. */
export const clearMemory = async (
  input: { scope: "you" } | { scope: "project"; project: string },
  now = new Date()
): Promise<void> => {
  const project = input.scope === "project" ? projectOf(input.project) : null;
  const scopes: Scope[] =
    project == null
      ? [{ kind: "you" }]
      : [
          { kind: "project", slug: project.slug },
          ...contactsOf(project.slug).map((contact): Scope => ({
            kind: "contact",
            slug: project.slug,
            contact,
          })),
        ];
  settled(
    await commit({ by: "you" }, () => {
      const writes: FileWrite[] = scopes.flatMap((scope) =>
        listNotes(scope)
          .filter((note) => note.type !== "card")
          .map((note) => noteDelete(note.scope, note.name))
      );
      if (project != null)
        writes.push(cardWrite(project, blankCard(project, "you", now)));
      return { writes, value: null };
    })
  );
};

// ── history ────────────────────────────────────────────────────────────────

const readOrNull = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** The journal line a change added. */
const addedLine = (entry: HistoryEntry): string =>
  (entry.after ?? "")
    .slice((entry.before ?? "").length)
    .trim()
    .replace(/^- [^·]*·\s*/, "");

const viewOf = (entry: HistoryEntry, scope: Scope): MemoryChangeView => {
  const name = noteNameOfPath(entry.path);
  const note =
    name == null
      ? null
      : parseNote(scope, name, entry.after ?? entry.before ?? "");
  const summary =
    name == null
      ? addedLine(entry)
      : note?.description || (note?.body.split("\n")[0] ?? "");
  return {
    id: `${entry.at}|${entry.path}`,
    at: entry.at,
    by: entry.by,
    model: entry.model ?? null,
    scope: scope.kind,
    project: scope.kind === "you" ? null : scope.slug,
    name,
    action:
      name == null
        ? "noted"
        : entry.before == null
          ? "saved"
          : entry.after == null
            ? "forgot"
            : "changed",
    summary,
    undoable:
      !(name === CARD_NAME && entry.before == null) &&
      readOrNull(absoluteOfHistory(entry.path)) === entry.after,
  };
};

/** The latest changes to notes and journals, newest first. */
export const memoryHistory = (limit = HISTORY_SHOWN): MemoryChangeView[] => {
  const views: MemoryChangeView[] = [];
  for (const entry of recentHistory(HISTORY_SCAN)) {
    // The migration's own bookkeeping files are not memory.
    const scope = scopeOfPath(entry.path);
    if (scope == null) continue;
    views.push(viewOf(entry, scope));
    if (views.length >= limit) break;
  }
  return views;
};

/** Put a file back as it was before one change, if nothing changed it since. */
export const undoChange = async (id: string): Promise<void> => {
  const at = id.slice(0, id.indexOf("|"));
  const relativePath = id.slice(id.indexOf("|") + 1);
  const file = insideMemory(relativePath);
  const entry = recentHistory(HISTORY_SCAN).find(
    (each) => each.at === at && each.path === relativePath
  );
  if (entry == null || scopeOfPath(relativePath) == null)
    throw new ConflictError("That change is no longer in the history.");
  if (noteNameOfPath(relativePath) === CARD_NAME && entry.before == null)
    throw new InvalidInputError("A project's card cannot be removed.");
  settled(
    await commit({ by: "you" }, () => {
      if (readOrNull(file) !== entry.after)
        throw new ConflictError(CHANGED_SINCE);
      return { writes: [{ file, contents: entry.before }], value: null };
    })
  );
};

export const memoryWithheld = (): MemoryWithheldView[] =>
  readMigrationReport()?.withheld ?? [];

// ── the app's own writes ──────────────────────────────────────────────────

/** The old stores move in once, with bots named; failures are logged. */
export const migrateMemory = async (
  botName: (id: string) => string
): Promise<void> => {
  try {
    await migrateOnce(botName);
  } catch (error) {
    console.error("[memory] migration failed", error);
  }
};

/** A dated line in a bot's project journal: what it did or settled elsewhere. */
export const noteToBotJournal = async (
  bot: { id: string; name: string },
  line: string
): Promise<void> => {
  const project = await ensureProject({
    kind: "bot",
    key: bot.id,
    name: bot.name,
  });
  if (project == null) {
    console.warn(`[memory] note for ${bot.id} dropped: memory is busy`);
    return;
  }
  const result = await commit({ by: "app" }, () => ({
    writes: [journalAppend({ kind: "project", slug: project.slug }, line)],
    value: null,
  }));
  if ("message" in result)
    console.warn(`[memory] note for ${bot.id} dropped: ${result.message}`);
};
