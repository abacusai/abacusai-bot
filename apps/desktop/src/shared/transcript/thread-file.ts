/**
 * `threads/<sessionId>.json`, the v2 thread file (spec 00 C.3), and the rules
 * that decide when a v1 transcript is converted into it. Pure: step 1, the
 * thread store and step 4 share these.
 */
import type { UIMessage } from "@tanstack/ai";
import * as v from "valibot";

import { v1ToUiMessages } from "./v1-to-ui-messages";
import type { TranscriptFileV1 } from "./v1-types";

export type ThreadSource =
  /** Written by step 1, the transition dual-write and the hydrate repair. */
  | { kind: "transcript-v1"; updatedAt: string; segments: number }
  /** Written by main's AG-UI persistence (later); never overwritten here. */
  | { kind: "agui"; migratedFrom?: { updatedAt: string } };

export interface ThreadFileV2 {
  version: 2;
  /** The session id. */
  threadId: string;
  /** ISO. For a v1-derived file, the v1 file's `updatedAt`. */
  updatedAt: string;
  source: ThreadSource;
  messages: UIMessage[];
  /** Durable run outcomes (spec 02 §14.7): `agui` files only. */
  runs?: unknown[];
}

// ─── v1 ──────────────────────────────────────────────────────────────────────

export type ParsedTranscriptV1 =
  | {
      status: "ok";
      file: Omit<TranscriptFileV1, "updatedAt"> & { updatedAt?: string };
    }
  | { status: "corrupt" }
  | { status: "not-v1" };

/**
 * The v1 file as `TranscriptService.read` accepts it: `version: 1` and a
 * `segments` array. `updatedAt` may be missing on a hand-made file; the
 * caller supplies a fallback (the file's mtime).
 */
export const parseTranscriptV1 = (text: string): ParsedTranscriptV1 => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "corrupt" };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { segments?: unknown }).segments)
  )
    return { status: "not-v1" };
  const file = parsed as Record<string, unknown>;
  return {
    status: "ok",
    file: {
      version: 1,
      sessionId: typeof file.sessionId === "string" ? file.sessionId : "",
      segments: file.segments as unknown[],
      ...(typeof file.updatedAt === "string" && { updatedAt: file.updatedAt }),
    },
  };
};

/** The v2 file derived from one v1 file. Deterministic in its input. */
export const v1ToThreadFile = (input: {
  threadId: string;
  updatedAt: string;
  segments: readonly unknown[];
}): ThreadFileV2 => ({
  version: 2,
  threadId: input.threadId,
  updatedAt: input.updatedAt,
  source: {
    kind: "transcript-v1",
    updatedAt: input.updatedAt,
    segments: input.segments.length,
  },
  messages: v1ToUiMessages(input.segments),
});

// ─── v2, as far as the conversion rules need it ─────────────────────────────

/** What the rules read from an existing v2 file. */
export type ThreadTwin =
  | { status: "missing" }
  /** Unparseable, or not a v2 file this code can classify. */
  | { status: "corrupt" }
  | { status: "ok"; source: ThreadSource; file: ThreadFileV2 };

/**
 * Reads only what the rules need (`version`, `source`, a `messages` array),
 * so a future `agui` field can never make a file look corrupt and be
 * overwritten.
 */
export const parseThreadTwin = (text: string): ThreadTwin => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "corrupt" };
  }
  if (typeof parsed !== "object" || parsed === null)
    return { status: "corrupt" };
  const file = parsed as Record<string, unknown>;
  const source = file.source as Record<string, unknown> | null | undefined;
  if (
    file.version !== 2 ||
    !Array.isArray(file.messages) ||
    typeof source !== "object" ||
    source === null
  )
    return { status: "corrupt" };
  if (source.kind === "agui") {
    const from = source.migratedFrom as Record<string, unknown> | undefined;
    return {
      status: "ok",
      source: {
        kind: "agui",
        ...(typeof from?.updatedAt === "string" && {
          migratedFrom: { updatedAt: from.updatedAt },
        }),
      },
      file: parsed as ThreadFileV2,
    };
  }
  if (source.kind === "transcript-v1" && typeof source.updatedAt === "string")
    return {
      status: "ok",
      source: {
        kind: "transcript-v1",
        updatedAt: source.updatedAt,
        segments: typeof source.segments === "number" ? source.segments : 0,
      },
      file: parsed as ThreadFileV2,
    };
  return { status: "corrupt" };
};

/** `a >= b` for two ISO times; by string when either does not parse. */
export const isSameOrNewer = (a: string, b: string): boolean => {
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isNaN(left) || Number.isNaN(right) ? a >= b : left >= right;
};

export type ConversionDecision =
  | { action: "convert"; kind: "create" | "replace-derived" | "replace-user" }
  | { action: "skip"; reason: "agui" | "up-to-date" };

/**
 * Convert when the twin is missing, unparseable, or v1-derived and older than
 * the v1 file; never over `agui`. An unparseable twin is replaced as
 * `replace-user`: it is most likely garbage, but nothing proves it derived.
 */
export const decideConversion = (
  v1UpdatedAt: string,
  twin: ThreadTwin
): ConversionDecision => {
  if (twin.status === "missing") return { action: "convert", kind: "create" };
  if (twin.status === "corrupt")
    return { action: "convert", kind: "replace-user" };
  if (twin.source.kind === "agui") return { action: "skip", reason: "agui" };
  return isSameOrNewer(twin.source.updatedAt, v1UpdatedAt)
    ? { action: "skip", reason: "up-to-date" }
    : { action: "convert", kind: "replace-derived" };
};

// ─── The schema (tests and debugging; the rules above never need it) ────────

const Meta = v.optional(v.looseObject({}));

const TextPartSchema = v.looseObject({
  type: v.literal("text"),
  content: v.string(),
  metadata: Meta,
});
const ThinkingPartSchema = v.looseObject({
  type: v.literal("thinking"),
  content: v.string(),
  stepId: v.optional(v.string()),
});
const ToolCallPartSchema = v.looseObject({
  type: v.literal("tool-call"),
  id: v.string(),
  name: v.string(),
  arguments: v.string(),
  state: v.picklist([
    "awaiting-input",
    "input-streaming",
    "input-complete",
    "approval-requested",
    "approval-responded",
    "complete",
    "error",
  ]),
  approval: v.optional(
    v.object({
      id: v.string(),
      needsApproval: v.boolean(),
      approved: v.optional(v.boolean()),
    })
  ),
  metadata: Meta,
});
const ToolResultPartSchema = v.looseObject({
  type: v.literal("tool-result"),
  id: v.optional(v.string()),
  toolCallId: v.string(),
  content: v.union([v.string(), v.array(v.unknown())]),
  state: v.picklist(["streaming", "complete", "error"]),
  outcome: v.optional(v.picklist(["cancelled", "denied"])),
  error: v.optional(v.string()),
  metadata: Meta,
});
const MediaSource = v.looseObject({
  type: v.picklist(["data", "url", "file"]),
  value: v.string(),
});
const ImagePartSchema = v.looseObject({
  type: v.literal("image"),
  source: MediaSource,
  metadata: Meta,
});
const VideoPartSchema = v.looseObject({
  type: v.literal("video"),
  source: MediaSource,
  metadata: Meta,
});
const OtherPartSchema = v.looseObject({
  type: v.picklist(["audio", "document", "structured-output", "ui-resource"]),
});

interface MessageShape {
  id: string;
  role: "system" | "user" | "assistant";
  parts: unknown[];
}

const SubagentPartSchema: v.GenericSchema<unknown> = v.looseObject({
  type: v.literal("subagent"),
  subagent: v.looseObject({
    id: v.string(),
    name: v.string(),
    status: v.picklist(["running", "finished", "error", "suspended"]),
    messages: v.array(v.lazy(() => UIMessageSchema)),
  }),
});

const PartSchema = v.union([
  TextPartSchema,
  ThinkingPartSchema,
  ToolCallPartSchema,
  ToolResultPartSchema,
  ImagePartSchema,
  VideoPartSchema,
  SubagentPartSchema,
  OtherPartSchema,
]);

export const UIMessageSchema: v.GenericSchema<MessageShape> = v.looseObject({
  id: v.string(),
  role: v.picklist(["system", "user", "assistant"]),
  parts: v.array(PartSchema),
  metadata: Meta,
});

export const ThreadFileV2Schema = v.looseObject({
  version: v.literal(2),
  threadId: v.string(),
  updatedAt: v.string(),
  source: v.variant("kind", [
    v.object({
      kind: v.literal("transcript-v1"),
      updatedAt: v.string(),
      segments: v.number(),
    }),
    v.looseObject({
      kind: v.literal("agui"),
      migratedFrom: v.optional(v.object({ updatedAt: v.string() })),
    }),
  ]),
  messages: v.array(UIMessageSchema),
  runs: v.optional(v.array(v.unknown())),
});
