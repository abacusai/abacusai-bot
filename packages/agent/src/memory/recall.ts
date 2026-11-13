import { ageOf } from "./core.js";
/**
 * Recall without a model call: the user's message is matched word by word
 * against the notes and journal lines this chat may read, and the few best
 * matches ride along with the message, after the cached prompt. Most turns
 * match nothing and cost nothing. A small model rarely opens memory on its
 * own, so what it needs has to come to it.
 */
import { contentWords } from "./gate.js";
import type { MemoryContext } from "./lanes.js";
import { mayRead, readsYou } from "./lanes.js";
import {
  historyCursor,
  listNotes,
  listProjects,
  memoryDir,
  type Note,
  type Project,
  readJournal,
  type Scope,
  oneLine,
} from "./notes.js";

const MAX_HITS = 3;
const MAX_CHARS = 1_500;
/** Journal lines looked at per scope, newest first. */
const JOURNAL_LINES = 1_500;
/** Rebuilt at least this often, for files edited outside the app. */
const INDEX_MAX_AGE_MS = 60_000;

interface Candidate {
  words: Set<string>;
  text: (now: Date) => string;
}

interface ScopeIndex {
  notes: Candidate[];
  journal: Candidate[];
}

/**
 * Notes and journal lines as word sets, read once and kept until memory
 * changes (every change moves the history cursor), so a turn reads no files.
 */
let index: {
  key: string;
  builtAt: number;
  projects: Project[];
  scopes: Map<string, ScopeIndex>;
} | null = null;

const currentIndex = (): NonNullable<typeof index> => {
  const key = `${memoryDir()}|${historyCursor()}`;
  if (
    index == null ||
    index.key !== key ||
    Date.now() - index.builtAt > INDEX_MAX_AGE_MS
  )
    index = {
      key,
      builtAt: Date.now(),
      projects: listProjects(),
      scopes: new Map(),
    };
  return index;
};

const scopeKey = (scope: Scope): string =>
  scope.kind === "you"
    ? "you"
    : scope.kind === "project"
      ? `p:${scope.slug}`
      : `c:${scope.slug}:${scope.contact}`;

/** Notes already in the prompt whole are not recalled again. */
const inPrompt = (note: Note): boolean =>
  note.type === "card" ||
  note.type === "rule" ||
  note.type === "preference" ||
  note.type === "profile";

const scopeIndex = (
  built: NonNullable<typeof index>,
  scope: Scope
): ScopeIndex => {
  const key = scopeKey(scope);
  const cached = built.scopes.get(key);
  if (cached != null) return cached;
  const where = label(scope);
  const entry: ScopeIndex = {
    notes: listNotes(scope)
      .filter((note) => !inPrompt(note))
      .map((note) => {
        const body = oneLine(note.body);
        return {
          words: contentWords(
            `${note.name} ${note.description} ${note.body} ${note.keywords ?? ""}`
          ),
          text: (now: Date) =>
            `[${where}] ${note.name} (${ageOf(note.updated, now)}): ${body}`,
        };
      }),
    journal: readJournal(scope)
      .slice(0, JOURNAL_LINES)
      .map((line) => ({
        words: contentWords(line),
        text: () => `[${where} journal] ${line.slice(2)}`,
      })),
  };
  built.scopes.set(key, entry);
  return entry;
};

const scopesFor = (
  context: MemoryContext,
  slug: string | null,
  projects: readonly Project[]
): Scope[] => {
  const scopes: Scope[] = [];
  if (slug != null) scopes.push({ kind: "project", slug });
  if (slug != null && context.contact != null)
    scopes.push({ kind: "contact", slug, contact: context.contact });
  if (readsYou(context)) scopes.push({ kind: "you" });
  if (context.lane === "owner" && !context.unattended)
    for (const project of projects)
      if (project.slug !== slug)
        scopes.push({ kind: "project", slug: project.slug });
  return scopes.filter((scope) => mayRead(context, scope, slug));
};

const label = (scope: Scope): string =>
  scope.kind === "you"
    ? "about the user"
    : scope.kind === "contact"
      ? "this person"
      : scope.slug;

/**
 * Up to three notes or journal lines that share rare words with `message`,
 * as one hidden line; "" when nothing matches well enough.
 */
export const recallFor = (
  context: MemoryContext,
  slug: string | null,
  message: string,
  now = new Date()
): string => {
  const query = contentWords(message);
  if (query.size === 0) return "";

  const built = currentIndex();
  const candidates: Candidate[] = [];
  for (const scope of scopesFor(context, slug, built.projects)) {
    const indexed = scopeIndex(built, scope);
    candidates.push(...indexed.notes);
    // Journals of the chat's own project only: another project's log is noise here.
    if (
      scope.kind === "contact" ||
      (scope.kind === "project" && scope.slug === slug)
    )
      candidates.push(...indexed.journal);
  }
  if (candidates.length === 0) return "";

  // A word found in few candidates says more than one found in many.
  const documents = new Map<string, number>();
  for (const candidate of candidates)
    for (const word of candidate.words)
      if (query.has(word)) documents.set(word, (documents.get(word) ?? 0) + 1);
  const weight = (word: string): number =>
    Math.log(1 + candidates.length / (1 + (documents.get(word) ?? 0)));

  const needed = Math.min(2, query.size);
  const hits = candidates
    .map((candidate) => {
      const shared = [...query].filter((word) => candidate.words.has(word));
      return {
        candidate,
        matched: shared.length,
        score: shared.reduce((sum, word) => sum + weight(word), 0),
      };
    })
    .filter((hit) => hit.matched >= needed)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_HITS);
  if (hits.length === 0) return "";

  const lines: string[] = [];
  let size = 0;
  for (const { candidate } of hits) {
    const text = candidate.text(now).slice(0, 600);
    if (size + text.length > MAX_CHARS) break;
    lines.push(`- ${text}`);
    size += text.length;
  }
  return [
    "Possibly relevant from memory (check before relying on it):",
    ...lines,
  ].join("\n");
};
