/**
 * Submit routing (spec 02 §8.3), pure: send, enqueue, blocked or nothing.
 * The composer never admits while busy (agent spec §3.1.6): a busy submit is
 * an `enqueue` into the agent's host queue. Plus the session title from a
 * first message, ported verbatim from the old transport
 * (`conversation/transport.ts:88-114`).
 */
import type { AgentMode } from "#shared/agent-types";

interface SubmitAttachment {
  path: string | null;
  state: "uploading" | "done" | "error";
}

export type SubmitRoute =
  | { kind: "noop" }
  | {
      kind: "blocked";
      reason: "read-only" | "question-pending" | "uploading" | "loading";
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
  const usable = input.attachments.filter((a) => a.state !== "error");
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

const MAX_TITLE_CHARS = 48;

/**
 * A sidebar-sized title from the first message: mentions keep their filename,
 * slash prefixes drop, fences collapse, and the cut lands on a word boundary.
 */
export const deriveSessionTitle = (text: string): string => {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*\/(\S+)/, "$1")
    .replace(/@([\w./-]+)/g, (_m, p: string) => p.split("/").pop() ?? p)
    .replace(/\s+/g, " ")
    .trim();

  if (flat.length === 0) return "";
  if (flat.length <= MAX_TITLE_CHARS) return flat;

  // slice() counts UTF-16 code units, so a cut can split a surrogate pair and
  // leave a `�`.
  const clipped = flat
    .slice(0, MAX_TITLE_CHARS)
    .replace(/[\uD800-\uDBFF]$/, "");
  const lastSpace = clipped.lastIndexOf(" ");

  return `${(lastSpace > 20 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
};
