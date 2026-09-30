/**
 * Decisions against a descriptor's allowed set (spec 02 §6.3 step 1,
 * agent spec §3.5.2), and the `ask_user_question` encoding ported byte for
 * byte from the old composer (`chat-composer.tsx:1018-1037`, F19).
 */
import type { PermissionDecision } from "@abacus-ai/agent";

import type { PermissionDescriptor } from "../../store/thread-store";
import type { CardAction } from "./presenters";

export const decisionKind = (decision: PermissionDecision): string =>
  typeof decision === "string" ? decision : decision.type;

export const isAllowed = (
  descriptor: PermissionDescriptor,
  decision: PermissionDecision
): boolean =>
  (descriptor.metadata.abacus.allowed as readonly string[]).includes(
    decisionKind(decision)
  );

export const allowedActions = (
  descriptor: PermissionDescriptor,
  actions: readonly CardAction[]
): CardAction[] =>
  actions.filter((action) => isAllowed(descriptor, action.decision));

/** With a note: allow → `accept_with_message`, deny → `reject_with_message`. */
export const withNote = (
  decision: PermissionDecision,
  note: string
): PermissionDecision => {
  const text = note.trim();
  if (text === "") return decision;
  if (decision === "accept")
    return { type: "accept_with_message", message: text };
  if (decision === "reject")
    return { type: "reject_with_message", message: text };
  return decision;
};

export interface QuestionItem {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

/** The questions the card shows: only those with options (as today). */
export const askableQuestions = (
  questions: readonly QuestionItem[]
): QuestionItem[] => questions.filter((q) => q?.options?.length > 0);

/**
 * `answers["question_" + i] = labels.join(", ") + (note ? " — " + note : "")`
 * over the askable questions, labels in option order, an unanswered
 * question skipped (its note too), exactly as `chat-composer.tsx:1018-1037`.
 */
export const encodeAnswers = (
  questions: readonly QuestionItem[],
  selected: ReadonlyMap<number, ReadonlySet<number>>,
  notes: ReadonlyMap<number, string>
): Record<string, string> => {
  const answers: Record<string, string> = {};
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const sel = selected.get(i);
    if (!sel || sel.size === 0) continue;
    const chosen = [...sel]
      .sort((a, b) => a - b)
      .map((idx) => q.options[idx]?.label ?? "")
      .filter(Boolean);
    const note = notes.get(i);
    answers[`question_${i}`] = note
      ? `${chosen.join(", ")} — ${note}`
      : chosen.join(", ");
  }
  return answers;
};
