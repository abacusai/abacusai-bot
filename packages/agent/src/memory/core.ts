/**
 * What a chat is told it remembers. The block is built once, when the chat
 * starts, and never rebuilt mid-session: it sits in the cached prompt prefix,
 * and changing it would make every remaining turn pay full price. A change
 * made elsewhere reaches a running chat as a hidden line before its next turn
 * (`memoryNews`), and the chat's own changes are in its tool results already.
 */
import { MAX_SCOPE_CORE_CHARS } from "./gate.js";
import { type MemoryContext, mayRead, projectSlug, readsYou } from "./lanes.js";
import {
  CARD_NAME,
  cardWrite,
  commit,
  findProject,
  type HistoryEntry,
  historySince,
  listNotes,
  listProjects,
  newProjectSlug,
  type Note,
  noteDelete,
  noteNameOfPath,
  type Project,
  type ProjectRef,
  readNote,
  type Scope,
  scopeOfPath,
  today,
} from "./notes.js";

/** The whole block: about-you, the project, and the list of projects. */
const MAX_CORE_CHARS = 6_000;
const MAX_PROJECT_LINES = 20;

const DAY_MS = 86_400_000;

/** "today", "3d", "5mo": how old a note is, as the index shows it. */
export const ageOf = (updated: string, now = new Date()): string => {
  const at = Date.parse(updated);
  if (Number.isNaN(at)) return "?";
  const days = Math.max(0, Math.floor((now.getTime() - at) / DAY_MS));
  if (days === 0) return "today";
  if (days < 60) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
};

const isExpired = (note: Note, now: Date): boolean =>
  note.expires != null &&
  !Number.isNaN(Date.parse(note.expires)) &&
  Date.parse(note.expires) + DAY_MS <= now.getTime();

const isWhole = (note: Note): boolean =>
  note.type === "rule" || note.type === "preference";

const indexLine = (note: Note, now: Date): string =>
  `- ${note.name}: ${note.description} (${note.type}, ${ageOf(note.updated, now)})`;

/** One scope's part of the block: the profile and rules whole, the rest as index lines. */
const scopeBlock = (notes: readonly Note[], now: Date): string[] => {
  const live = notes.filter(
    (note) => note.type !== "card" && !isExpired(note, now)
  );
  const lines: string[] = [];
  const profile = live.find((note) => note.type === "profile");
  if (profile != null) lines.push(profile.body);
  const whole = live.filter(isWhole);
  if (whole.length > 0) {
    lines.push("Rules and preferences:");
    for (const note of whole)
      lines.push(`- ${note.body.replace(/\s*\r?\n\s*/g, " ")} [${note.name}]`);
  }
  const indexed = live.filter(
    (note) => note.type !== "profile" && !isWhole(note)
  );
  if (indexed.length > 0) {
    lines.push('Notes (open one with memory action "read"):');
    for (const note of indexed) lines.push(indexLine(note, now));
  }
  return lines;
};

/** Cut to `limit` characters at a line, saying what was left out. */
const capLines = (lines: string[], limit: number): string[] => {
  const kept: string[] = [];
  let size = 0;
  for (const [index, line] of lines.entries()) {
    if (size + line.length + 1 > limit) {
      kept.push(
        `(${lines.length - index} more lines not shown: use memory action "search".)`
      );
      break;
    }
    kept.push(line);
    size += line.length + 1;
  }
  return kept;
};

/** The card a project starts with, and returns to when its memory is cleared. */
export const blankCard = (
  project: ProjectRef & { slug: string },
  by: Note["by"],
  now = new Date()
): Note => ({
  scope: { kind: "project", slug: project.slug },
  name: CARD_NAME,
  description: `What ${project.name} is and where it stands`,
  type: "card",
  body: [
    `What: ${project.name}`,
    ...(project.path != null ? [`Where: ${project.path}`] : []),
    "Goal:",
    "Status:",
    "Decisions:",
  ].join("\n"),
  updated: today(now),
  by,
});

/**
 * The project this chat works in, created with a first card on first use: a
 * folder the user picked, a bot or a routine is a project from the start.
 */
export const ensureProject = async (
  ref: ProjectRef,
  now = new Date()
): Promise<Project | null> => {
  const existing = findProject(ref.key);
  if (existing != null) return existing;
  const result = await commit({ by: "app" }, () => {
    const again = findProject(ref.key);
    if (again != null) return { writes: [], value: again };
    const project: Project = { ...ref, slug: newProjectSlug(ref) };
    const card = blankCard(project, "app", now);
    return { writes: [cardWrite(project, card)], value: project };
  });
  return result.ok ? result.value : null;
};

/** A project's card and index, as the `open` action shows it. */
export const projectSummary = (project: Project, now = new Date()): string => {
  const notes = listNotes({ kind: "project", slug: project.slug });
  const card = notes.find((note) => note.type === "card");
  return [
    `Project ${project.name} (${project.kind}${project.path != null ? `, ${project.path}` : ""}), its card:`,
    card?.body ?? "(empty)",
    ...scopeBlock(notes, now),
  ].join("\n");
};

/** Expired status notes are removed when a chat starts; nobody needs to ask. */
export const tidy = async (scopes: readonly Scope[], now = new Date()) => {
  const expired = scopes.flatMap((scope) =>
    listNotes(scope).filter((note) => isExpired(note, now))
  );
  if (expired.length === 0) return;
  await commit({ by: "app" }, () => ({
    writes: expired
      .filter((note) => readNote(note.scope, note.name) != null)
      .map((note) => noteDelete(note.scope, note.name)),
    value: null,
  }));
};

const HEADER = [
  "Memory: what you know from earlier chats, as it stood when this chat started.",
  "Each note is true as of its age. Before you tell the user something is or isn't so, check it live (the file, the connector, the routine list); if a note is wrong, fix it with the memory tool in this turn.",
].join("\n");

/**
 * The memory block for this chat's system prompt, or null when it has none.
 * Called once per session.
 */
export const memoryBlock = async (
  context: MemoryContext,
  now = new Date()
): Promise<string | null> => {
  if (context.lane === "off" || context.lane === "sender") return null;

  const project =
    context.project != null ? await ensureProject(context.project, now) : null;
  const projectScope: Scope | null =
    project != null ? { kind: "project", slug: project.slug } : null;
  const contactScope: Scope | null =
    project != null && context.contact != null
      ? { kind: "contact", slug: project.slug, contact: context.contact }
      : null;

  const scopes = [
    ...(readsYou(context) ? [{ kind: "you" } as Scope] : []),
    ...(projectScope != null ? [projectScope] : []),
    ...(contactScope != null ? [contactScope] : []),
  ];
  await tidy(scopes, now);

  const sections: string[] = [];

  if (readsYou(context)) {
    // The user's rules are the standing instructions block, sent separately.
    const you = scopeBlock(
      listNotes({ kind: "you" }).filter((note) => note.type !== "rule"),
      now
    );
    if (you.length > 0)
      sections.push(
        ["About the user:", ...capLines(you, MAX_SCOPE_CORE_CHARS)].join("\n")
      );
  }

  if (project != null && projectScope != null) {
    const notes = listNotes(projectScope);
    const card = notes.find((note) => note.type === "card");
    const label =
      project.kind === "bot"
        ? `This bot (${project.name})`
        : project.kind === "routine"
          ? `This routine (${project.name})`
          : `This project (${project.name})`;
    sections.push(
      [
        `${label}, its card:`,
        card?.body ?? "(empty)",
        ...capLines(scopeBlock(notes, now), MAX_SCOPE_CORE_CHARS),
      ].join("\n")
    );
  }

  if (contactScope != null) {
    const contact = scopeBlock(listNotes(contactScope), now);
    sections.push(
      [
        "About the person you are talking with:",
        ...(contact.length > 0 ? contact : ["(nothing yet)"]),
      ].join("\n")
    );
  }

  if (project == null && readsYou(context)) {
    const projects = listProjects().slice(0, MAX_PROJECT_LINES);
    if (projects.length > 0)
      sections.push(
        [
          'The user\'s projects (open one\'s notes with memory action "search" or "read" when the chat is about it):',
          ...projects.map(
            (each) =>
              `- ${each.name} (${each.kind}${each.path != null ? `, ${each.path}` : ""})`
          ),
        ].join("\n")
      );
  }

  const body = sections.join("\n\n");
  const instructions = memoryInstructions(context);
  if (body.length === 0)
    return `${HEADER}\n\n(nothing saved yet)\n\n${instructions}`;
  return `${HEADER}\n\n${capLines(body.split("\n"), MAX_CORE_CHARS).join("\n")}\n\n${instructions}`;
};

/** The rules, short enough that every model follows them. */
const memoryInstructions = (context: MemoryContext): string => {
  if (context.lane === "bot-sender")
    return [
      "How to use memory here (memory tool):",
      "- Save what this person tells you that will matter next time: who they are, what they asked for, what was agreed.",
      "- One fact per note. Update a note rather than adding a second one.",
    ].join("\n");
  if (context.unattended)
    return 'How to use memory here: add what this run did or found with memory action "note" (one line). You cannot change other notes in a run nobody is watching.';
  return [
    "How to use memory (memory tool):",
    "- Save when the user states a preference, a rule, a correction, a decision, or a lasting fact about themselves or their project. Save it when you hear it.",
    '- One fact per note. If a note already covers it, use "update" on that note; never add a second.',
    "- When the user corrects something, update the note that was wrong.",
    "- Never save passwords, keys or codes; never save that something does not exist or is not connected.",
    '- Things that change (status, waiting on someone) are type "status" with "expires".',
    '- Run logs and what you did go in "note" (a dated journal line), not in notes.',
    "- Only say something is saved after the tool said Saved.",
    '- A rule about the user (type "rule", about "you") applies to every chat from then on. Notes the user wrote themselves only they change, on the Memory page.',
    ...(context.project == null || context.project.kind === "topic"
      ? [
          '- When this chat is about one of the projects above, or about ongoing work the user keeps coming back to, use "open" with its name (a new name starts a project) before saving project facts.',
        ]
      : []),
  ].join("\n");
};

/**
 * Changes made elsewhere since `cursor` (another chat, the Memory page), as
 * one hidden line for the next turn, and the cursor to keep. Only what this
 * chat may read, and never its own changes.
 */
const noteTypeOf = (entry: HistoryEntry): string | null =>
  "appended" in entry
    ? null
    : (/^type: (\S+)$/m.exec(entry.after ?? entry.before ?? "")?.[1] ?? null);

export const memoryNews = (
  context: MemoryContext,
  cursor: string,
  session: string
): { text: string; cursor: string } => {
  const { entries, cursor: next } = historySince(cursor);
  const slug = projectSlug(context);
  const lines: string[] = [];
  for (const entry of entries) {
    // Journal lines are recalled by their words, not announced.
    if (entry.session === session || "appended" in entry) continue;
    const scope = scopeOfPath(entry.path);
    const name = noteNameOfPath(entry.path);
    if (scope == null || name == null || !mayRead(context, scope, slug))
      continue;
    // The user's rules reach every chat live, as its standing instructions.
    if (scope.kind === "you" && noteTypeOf(entry) === "rule") continue;
    if (scope.kind === "you" && !readsYou(context)) continue;
    const where = scope.kind === "you" ? "about the user" : `in ${scope.slug}`;
    if (entry.after == null) {
      lines.push(`- forgotten ${where}: ${name}`);
      continue;
    }
    const note = readNote(scope, name);
    if (note == null) continue;
    lines.push(
      `- ${entry.before == null ? "saved" : "changed"} ${where}: ${name}: ${
        note.type === "rule" ||
        note.type === "preference" ||
        note.type === "card"
          ? note.body.replace(/\s*\r?\n\s*/g, " ")
          : note.description
      }`
    );
  }
  const unique = [...new Set(lines)];
  return {
    text:
      unique.length === 0
        ? ""
        : ["Memory changed since this chat started:", ...unique].join("\n"),
    cursor: next,
  };
};
