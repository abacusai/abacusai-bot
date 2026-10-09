/**
 * Submit routing (spec 02 §8.3), pure: send, enqueue, blocked or nothing.
 * The composer never admits while busy (agent spec §3.1.6): a busy submit is
 * an `enqueue` into the agent's host queue. Plus the session title from a
 * first message, ported verbatim from the old transport
 * (`conversation/transport.ts:88-114`).
 */
import type { AgentMode } from "@abacus-ai/contract/agent-types";

interface SubmitAttachment {
  path: string | null;
  state: "uploading" | "done" | "error";
}

export type SubmitRoute =
  | { kind: "noop" }
  | {
      kind: "blocked";
      reason:
        | "read-only"
        | "question-pending"
        | "uploading"
        | "loading"
        | "attachment-error";
    }
  | {
      kind: "send";
      text: string;
      forwardedProps?: { mode?: AgentMode; model?: string };
    }
  | { kind: "enqueue"; text: string };

export interface SubmitInput {
  text: string;
  attachments: readonly SubmitAttachment[];
  busy: boolean;
  readOnly: boolean;
  questionPending: boolean;
  /** No agent runtime yet (a new session): mode and model go with the send. */
  preStart: boolean;
  hydrated: boolean;
  mode?: AgentMode;
  model?: string;
  /** Bots (03 §24.2): the mode goes with every admission, not only pre-start. */
  fixedMode?: AgentMode;
  /** An IME composition is in progress: never submit. */
  composing?: boolean;
}

/** Attachments reach the agent as `@<absolute path>` lines (§8.6). */
const withAttachmentRefs = (
  text: string,
  attachments: readonly SubmitAttachment[]
): string => {
  const refs = attachments
    .filter(
      (attachment) => attachment.state === "done" && attachment.path != null
    )
    .map((attachment) => `@${attachment.path}`);
  if (refs.length === 0) return text;
  const body = text.trim();
  return body === "" ? refs.join("\n") : `${text}\n\n${refs.join("\n")}`;
};

export const routeSubmit = (input: SubmitInput): SubmitRoute => {
  if (input.composing === true) return { kind: "noop" };
  if (input.attachments.some((attachment) => attachment.state === "error"))
    return { kind: "blocked", reason: "attachment-error" };
  const usable = input.attachments;
  if (input.text.trim() === "" && usable.length === 0) return { kind: "noop" };
  if (input.readOnly) return { kind: "blocked", reason: "read-only" };
  if (input.questionPending)
    return { kind: "blocked", reason: "question-pending" };
  if (usable.some((attachment) => attachment.state === "uploading"))
    return { kind: "blocked", reason: "uploading" };
  if (!input.hydrated) return { kind: "blocked", reason: "loading" };
  const text = withAttachmentRefs(input.text, usable);
  if (input.busy) return { kind: "enqueue", text };
  const mode = input.fixedMode ?? (input.preStart ? input.mode : undefined);
  const model = input.preStart ? input.model : undefined;
  const forwardedProps = {
    ...(mode != null ? { mode } : {}),
    ...(model != null ? { model } : {}),
  };
  return Object.keys(forwardedProps).length > 0
    ? { kind: "send", text, forwardedProps }
    : { kind: "send", text };
};

export { deriveSessionTitle } from "@abacus-ai/contract/transcript/session-title";
