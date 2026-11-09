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
  listNotes,
  listProjects,
  type Note,
  readJournal,
  type Scope,
} from "./notes.js";

const MAX_HITS = 3;
const MAX_CHARS = 1_500;
/** Journal lines looked at per scope, newest first. */
const JOURNAL_LINES = 1_500;

interface Candidate {
  words: Set<string>;
  text: string;
}

/** Notes already in the prompt whole are not recalled again. */
const inPrompt = (note: Note): boolean =>
  note.type === "card" ||
  note.type === "rule" ||
  note.type === "preference" ||
  note.type === "profile";

const scopesFor = (context: MemoryContext, slug: string | null): Scope[] => {
  const scopes: Scope[] = [];
  if (slug != null) scopes.push({ kind: "project", slug });
  if (slug != null && context.contact != null)
    scopes.push({ kind: "contact", slug, contact: context.contact });
  if (readsYou(context)) scopes.push({ kind: "you" });
  if (context.lane === "owner" && !context.unattended)
    for (const project of listProjects())
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

  const candidates: Candidate[] = [];
  for (const scope of scopesFor(context, slug)) {
    for (const note of listNotes(scope)) {
      if (inPrompt(note)) continue;
      candidates.push({
        words: contentWords(`${note.name} ${note.description} ${note.body}`),
        text: `[${label(scope)}] ${note.name} (${ageOf(note.updated, now)}): ${note.body.replace(/\s*\r?\n\s*/g, " ")}`,
      });
    }
    // Journals of the chat's own project only: another project's log is noise here.
    if (
      scope.kind === "you" ||
      (scope.kind === "project" && scope.slug !== slug)
    )
      continue;
    for (const line of readJournal(scope).slice(0, JOURNAL_LINES))
      candidates.push({
        words: contentWords(line),
        text: `[${label(scope)} journal] ${line.slice(2)}`,
      });
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
    const text = candidate.text.slice(0, 600);
    if (size + text.length > MAX_CHARS) break;
    lines.push(`- ${text}`);
    size += text.length;
  }
  return [
    "Possibly relevant from memory (check before relying on it):",
    ...lines,
  ].join("\n");
};
