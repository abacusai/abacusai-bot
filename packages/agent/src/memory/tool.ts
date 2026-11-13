import { redactIdNumbers } from "../traveler/id-numbers.js";
/**
 * `memory`: the one way a model reads and changes memory. The app writes the
 * file, its header and the date; the model only supplies words, so a small
 * model cannot break a note. Every write passes gate.ts under the folder lock.
 */
import { ageOf, ensureProject, projectSummary } from "./core.js";
import {
  checkDraft,
  contentWords,
  looksSecret,
  overlap,
  relatedNotes,
} from "./gate.js";
import {
  hasMemory,
  type MemoryContext,
  mayJournal,
  mayRead,
  mayWrite,
  readsYou,
} from "./lanes.js";
import {
  CARD_NAME,
  cardWrite,
  chatProjectWrite,
  commit,
  type FileWrite,
  isValidName,
  journalAppend,
  listNotes,
  listProjects,
  NOTE_TYPES,
  type Note,
  noteDelete,
  type NoteType,
  noteWrite,
  type Project,
  readJournal,
  readNote,
  type Scope,
  slugify,
  today,
} from "./notes.js";

export const MEMORY_TOOL_NAME = "memory";

/** What the chat knows about the turn the tool runs in. */
export interface MemoryTurn {
  /** The user's own words this turn ("" when the turn is the app's). */
  userWords(): string;
  /** The model answering, stamped on what it writes. */
  model(): string | undefined;
  /** Told when a note was saved, changed or forgotten this turn. */
  saved(): void;
  /** Told when the chat opened a project, so recall searches it. */
  opened?(project: Project): void;
  /**
   * Asked before a journal line is added in a chat someone is watching: false
   * when this turn already added one. A journal is for finished work, not a
   * running log of the chat.
   */
  journal?(): boolean;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: null;
  isError?: boolean;
}

interface PiToolDefinitionLike {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>
  ) => Promise<ToolResult>;
}

const reply = (body: string, isError = false): ToolResult => ({
  content: [{ type: "text", text: body }],
  details: null,
  ...(isError ? { isError: true } : {}),
});

const ABOUT_YOU_TYPES: ReadonlySet<NoteType> = new Set([
  "profile",
  "rule",
  "preference",
]);

const SEARCH_LIMIT = 8;

/** The user's own words in memory are theirs: a model adds beside them, never over them. */
const userWrote = (note: Note): boolean => note.by === "you";
const USER_WROTE = (name: string): string =>
  `The user wrote "${name}" themselves, so only they change it, on the Memory page. Tell them what you would change.`;

const string = (value: unknown): string =>
  typeof value === "string" ? value : "";

export function buildMemoryTool(
  context: MemoryContext,
  turn: MemoryTurn
): PiToolDefinitionLike | null {
  if (!hasMemory(context)) return null;

  let project: Project | null | undefined;
  const currentProject = async (): Promise<Project | null> => {
    if (project === undefined)
      project =
        context.project != null ? await ensureProject(context.project) : null;
    return project;
  };

  const scopeFor = async (about: string, type: NoteType): Promise<Scope> => {
    const own = await currentProject();
    if (context.lane === "bot-sender" && own != null && context.contact != null)
      return { kind: "contact", slug: own.slug, contact: context.contact };
    if (about === "you") return { kind: "you" };
    if (about === "project" && own != null)
      return { kind: "project", slug: own.slug };
    if (about.length > 0 && about !== "project") {
      const named = listProjects().find(
        (each) => each.slug === about || each.name === about
      );
      if (named != null) return { kind: "project", slug: named.slug };
    }
    // Unsaid: who the user is goes about them, the rest to the project at hand.
    return ABOUT_YOU_TYPES.has(type) || own == null
      ? { kind: "you" }
      : { kind: "project", slug: own.slug };
  };

  /** Every scope this chat may read, its own project first. */
  const readable = async (): Promise<Scope[]> => {
    const own = await currentProject();
    const slug = own?.slug ?? null;
    const scopes: Scope[] = [];
    if (own != null) scopes.push({ kind: "project", slug: own.slug });
    if (own != null && context.contact != null)
      scopes.push({
        kind: "contact",
        slug: own.slug,
        contact: context.contact,
      });
    if (readsYou(context)) scopes.push({ kind: "you" });
    for (const each of listProjects())
      if (each.slug !== slug) scopes.push({ kind: "project", slug: each.slug });
    return scopes.filter((scope) => mayRead(context, scope, slug));
  };

  const findNote = async (name: string): Promise<Note | null> => {
    for (const scope of await readable()) {
      const note = readNote(scope, name);
      if (note != null) return note;
    }
    return null;
  };

  const where = (scope: Scope): string =>
    scope.kind === "you"
      ? "about the user"
      : scope.kind === "contact"
        ? "about this person"
        : `in project ${scope.slug}`;

  const save = async (
    params: Record<string, unknown>,
    updating: Note | null
  ): Promise<ToolResult> => {
    // A card stays a card: it carries the project's binding.
    const typeText =
      updating?.type === "card"
        ? "card"
        : string(params.type) || updating?.type || "fact";
    const type = (
      typeText === "card" ||
      (NOTE_TYPES as readonly string[]).includes(typeText)
        ? typeText
        : ""
    ) as NoteType;
    if (type.length === 0)
      return reply(`type must be one of: ${NOTE_TYPES.join(", ")}.`, true);
    if (type === "card" && updating?.type !== "card")
      return reply(
        `The project card is updated with action "update", name "${CARD_NAME}".`,
        true
      );

    const scope =
      updating?.scope ?? (await scopeFor(string(params.about), type));
    const own = await currentProject();
    if (!mayWrite(context, scope, own?.slug ?? null))
      return reply(
        context.unattended
          ? 'Nobody is watching this run, so notes cannot change here. Add a journal line with action "note".'
          : `This chat cannot change notes ${where(scope)}.`,
        true
      );

    const text = string(params.text);
    const name =
      updating?.name ??
      (string(params.name).trim() ||
        slugify(
          string(params.description) || text.split(/\s+/).slice(0, 6).join(" ")
        ));
    if (!isValidName(name) && name !== CARD_NAME)
      return reply(
        "name must be short, lowercase letters, digits and dashes (e.g. prefers-short-replies).",
        true
      );
    const replaces = string(params.replaces).trim();
    const now = new Date();

    const result = await commit(
      {
        by: authorOf(context),
        ...(turn.model() ? { model: turn.model()! } : {}),
      },
      () => {
        const siblings = listNotes(scope);
        const current = updating
          ? siblings.find((note) => note.name === updating.name)
          : null;
        if (updating != null && current == null)
          return `There is no note "${updating.name}" ${where(scope)} any more.`;
        if (
          replaces.length > 0 &&
          !siblings.some((note) => note.name === replaces)
        )
          return `"replaces" names "${replaces}", which is not a note ${where(scope)}.`;
        const replaced = siblings.find((note) => note.name === replaces);
        if (replaced != null && userWrote(replaced))
          return USER_WROTE(replaced.name);
        const draft = checkDraft({
          draft: {
            name,
            description:
              string(params.description) || current?.description || "",
            type,
            body: text.length > 0 ? text : (current?.body ?? ""),
            ...(string(params.expires) || current?.expires
              ? { expires: string(params.expires) || current!.expires! }
              : {}),
            ...(string(params.keywords) || current?.keywords
              ? { keywords: string(params.keywords) || current!.keywords! }
              : {}),
          },
          siblings,
          updating: current?.name ?? (replaces || null),
          userWords: turn.userWords(),
          byUser: false,
          now,
        });
        if (typeof draft === "string") return draft;
        const note: Note = {
          scope,
          ...draft,
          updated: today(now),
          by: authorOf(context),
          ...(turn.model() ? { model: turn.model()! } : {}),
        };
        const writes: FileWrite[] = [
          note.type === "card" && own != null
            ? cardWrite(own, note)
            : noteWrite(note),
          ...(replaces.length > 0 && replaces !== name
            ? [noteDelete(scope, replaces)]
            : []),
        ];
        return {
          writes,
          value: { note, related: relatedNotes(draft, siblings) },
        };
      }
    );
    if (!result.ok) return reply(result.message, true);
    turn.saved();
    const { note, related } = result.value;
    return reply(
      [
        `Saved "${note.name}" ${where(scope)}${updating ? " (updated)" : ""}${replaces ? `, replacing "${replaces}"` : ""}.`,
        ...(related.length > 0
          ? [
              "Related notes; if one now says something different, update or forget it:",
              ...related.map(
                (each) =>
                  `- ${each.name}: ${each.description} (${ageOf(each.updated)})`
              ),
            ]
          : []),
      ].join("\n")
    );
  };

  return {
    name: MEMORY_TOOL_NAME,
    label: MEMORY_TOOL_NAME,
    description: [
      "Your memory across chats. The app writes the files; you give the words.",
      "Most turns need no memory call: write only what must outlive this chat.",
      "",
      'Actions: "save" a new note (text, type, optional name, description, about),',
      '"update" a note by name (new text and/or description), "forget" a note by name,',
      '"read" a note by name, "search" notes and journals (query),',
      '"note" a dated journal line when a piece of work is finished and worth finding later (text; one per task, never per message),',
      '"open" a project when this chat turns out to be about one (project: its name, or a new name for ongoing work the user returns to).',
      "",
      `Types: ${NOTE_TYPES.join(", ")}. "status" needs "expires" (YYYY-MM-DD, 14 days at most).`,
      'about: "you" (who the user is, their rules and preferences) or "project" (this project). Leave it out to let the app choose.',
      `The project card is the note "${CARD_NAME}": update it when the goal, status or a decision changes.`,
      "replaces: the name of a note this one supersedes; that note is removed.",
      "keywords: other words someone would use to ask about the note, and the same words in the user's language when it is not the note's. Memory is found by matching words, so this is how a note is found later.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["save", "update", "forget", "read", "search", "note", "open"],
        },
        text: {
          type: "string",
          description: "The note's text, or the journal line.",
        },
        type: { type: "string", enum: [...NOTE_TYPES, "card"] },
        name: {
          type: "string",
          description:
            "Short lowercase name with dashes; required for update, forget and read.",
        },
        description: {
          type: "string",
          description: "One line saying what the note is, shown in the index.",
        },
        about: { type: "string", description: '"you" or "project".' },
        expires: {
          type: "string",
          description: "YYYY-MM-DD, for status notes.",
        },
        replaces: {
          type: "string",
          description: "Name of a note this one supersedes.",
        },
        keywords: {
          type: "string",
          description:
            "Other words for the note, comma separated, including the user's language.",
        },
        query: { type: "string", description: "Words to search for." },
        project: {
          type: "string",
          description:
            'For "open": the project this chat is about (an existing name, or a new one).',
        },
      },
      required: ["action"],
    },
    execute: async (_id, params) => {
      const action = string(params.action);
      const name = string(params.name).trim();

      if (action === "save") return save(params, null);

      if (action === "open") {
        const wanted = (string(params.project) || string(params.name)).trim();
        if (wanted.length === 0)
          return reply('Say which project: "project" is its name.', true);
        if (context.lane !== "owner" || context.unattended)
          return reply("This chat cannot open other projects.", true);
        if (context.project != null && context.project.kind !== "topic")
          return reply(
            `This chat belongs to ${context.project.name}. Read another project's notes with "search" or "read".`,
            true
          );
        const lower = wanted.toLowerCase();
        const found =
          listProjects().find(
            (each) => each.slug === lower || each.name.toLowerCase() === lower
          ) ??
          (await ensureProject({
            kind: "topic",
            key: `topic:${slugify(wanted)}`,
            name: wanted,
          }));
        if (found == null) return reply("Memory is busy; try again.", true);
        const session = process.env.ABACUSAI_BOT_SESSION_ID;
        if (session != null)
          await commit({ by: authorOf(context) }, () => ({
            writes: [chatProjectWrite(session, found.key)],
            value: null,
          }));
        project = found;
        turn.opened?.(found);
        return reply(
          `This chat now works in ${found.name}; "save" with about "project" goes there.\n\n${projectSummary(found)}`
        );
      }

      if (action === "update") {
        const note = await findNote(name);
        if (note == null)
          return reply(
            `There is no note "${name}". Use "search" to find its name, or "save" a new one.`,
            true
          );
        if (userWrote(note) && note.type !== "card")
          return reply(USER_WROTE(note.name), true);
        return save(params, note);
      }

      if (action === "forget") {
        const note = await findNote(name);
        if (note == null) return reply(`There is no note "${name}".`, true);
        if (note.type === "card")
          return reply(
            "The project card cannot be forgotten; update it instead.",
            true
          );
        if (userWrote(note)) return reply(USER_WROTE(note.name), true);
        const own = await currentProject();
        if (!mayWrite(context, note.scope, own?.slug ?? null))
          return reply(
            `This chat cannot change notes ${where(note.scope)}.`,
            true
          );
        const result = await commit(
          {
            by: authorOf(context),
            ...(turn.model() ? { model: turn.model()! } : {}),
          },
          () => ({ writes: [noteDelete(note.scope, note.name)], value: null })
        );
        if (!result.ok) return reply(result.message, true);
        turn.saved();
        return reply(`Forgot "${note.name}" ${where(note.scope)}.`);
      }

      if (action === "read") {
        const note = await findNote(name);
        if (note == null)
          return reply(
            `There is no note "${name}". Use "search" to find it.`,
            true
          );
        return reply(
          `${note.name} (${note.type}, ${where(note.scope)}, ${ageOf(note.updated)}${note.expires ? `, until ${note.expires}` : ""}): ${note.description}\n\n${note.body}`
        );
      }

      if (action === "search") {
        const query = string(params.query) || string(params.text);
        const hits = await search(query, await readable());
        if (hits.length === 0)
          return reply(`Nothing in memory matches "${query}".`);
        return reply(hits.join("\n"));
      }

      if (action === "note") {
        // ID numbers are withheld here as in notes (gate.ts).
        const text = redactIdNumbers(string(params.text).trim());
        if (text.length === 0)
          return reply("Nothing to note: text is empty.", true);
        if (text.length > 500)
          return reply(
            "A journal line holds 500 characters; say it shorter.",
            true
          );
        const own = await currentProject();
        const scope: Scope =
          own == null
            ? { kind: "you" }
            : context.contact != null
              ? { kind: "contact", slug: own.slug, contact: context.contact }
              : { kind: "project", slug: own.slug };
        if (!mayJournal(context, scope, own?.slug ?? null))
          return reply("This chat cannot keep a journal.", true);
        if (!context.unattended && turn.journal?.() === false)
          return reply(
            "This turn already added a journal line; one per task is enough.",
            true
          );
        // Secrets are refused here too; what happened at a moment is what a journal is for.
        if (looksSecret(text))
          return reply(
            "That looks like a password, key or code. Memory never keeps those.",
            true
          );
        const result = await commit({ by: authorOf(context) }, () => ({
          writes: [journalAppend(scope, text)],
          value: null,
        }));
        if (!result.ok) return reply(result.message, true);
        return reply("Noted in the journal.");
      }

      return reply(
        'action must be "save", "update", "forget", "read", "search", "note" or "open".',
        true
      );
    },
  };
}

const authorOf = (context: MemoryContext): Note["by"] =>
  context.lane === "routine"
    ? "routine"
    : context.lane === "bot-sender"
      ? "contact"
      : context.project?.kind === "bot"
        ? "bot"
        : "chat";

/** Notes and journal lines that share the query's words, best first. */
const search = async (query: string, scopes: Scope[]): Promise<string[]> => {
  const words = contentWords(query);
  if (words.size === 0) return [];
  const scored: Array<{ score: number; line: string }> = [];
  for (const scope of scopes) {
    const label =
      scope.kind === "you"
        ? "about the user"
        : scope.kind === "contact"
          ? "contact"
          : scope.slug;
    for (const note of listNotes(scope)) {
      const score = overlap(
        words,
        contentWords(
          `${note.name} ${note.description} ${note.body} ${note.keywords ?? ""}`
        )
      );
      const hit = [...words].some((word) =>
        `${note.name} ${note.description} ${note.body} ${note.keywords ?? ""}`
          .toLowerCase()
          .includes(word)
      );
      if (score > 0 || hit)
        scored.push({
          score: score + (hit ? 0.05 : 0),
          line: `[${label}] ${note.name}: ${note.description} (${ageOf(note.updated)})`,
        });
    }
    for (const line of readJournal(scope).slice(0, 2_000)) {
      const lower = line.toLowerCase();
      const matched = [...words].filter((word) => lower.includes(word)).length;
      if (matched > 0)
        scored.push({
          score: (matched / words.size) * 0.5,
          line: `[${label} journal] ${line.slice(2, 300)}`,
        });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, SEARCH_LIMIT)
    .map(({ line }) => line);
};
