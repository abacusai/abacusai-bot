/**
 * `threads/<sessionId>.json`, the v2 thread file (spec 00 C.3), and the rules
 * that decide when a v1 transcript is converted into it. Pure: step 1, the
 * thread store and step 4 share these. Hashing and file access stay with the
 * callers (main), which pass the v1 file's fingerprint in.
 */
import type { UIMessage } from "@tanstack/ai";
import * as v from "valibot";

import { v1ToUiMessages } from "./v1-to-ui-messages";
import type { TranscriptFileV1 } from "./v1-types";

export type ThreadSource =
  /** Written by step 1, the transition dual-write and the hydrate repair. */
  | {
      kind: "transcript-v1";
      updatedAt: string;
      segments: number;
      /**
       * A hash of the v1 file's bytes. Freshness compares it, never the
       * clock: two saves in one millisecond, or a clock stepping back, can
       * not make a stale twin look current. Absent on files written before
       * it existed; those fall back to `updatedAt`.
       */
      fingerprint?: string;
      /** The clear marker this file was written after (`ClearMarker.token`). */
      afterClear?: string;
    }
  /** Written by main's AG-UI persistence; never overwritten here. */
  | {
      kind: "agui";
      migratedFrom?: { updatedAt: string };
      afterClear?: string;
    };

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

/**
 * `threads/<sessionId>.cleared`: written before a conversation's files are
 * removed (reset, session or workspace deletion) and dropped once both are
 * gone. While it exists, a twin counts only if it was written after it
 * (`source.afterClear === token`), and a v1 file only if its bytes changed
 * since (`v1Fingerprint`), so a failed or interrupted removal can never
 * bring cleared history back, across restarts too.
 */
export interface ClearMarker {
  version: 1;
  token: string;
  clearedAt: string;
  /** The v1 file's fingerprint when it was cleared, if it still existed. */
  v1Fingerprint?: string;
}

export const parseClearMarker = (text: string): ClearMarker | null => {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed?.token !== "string") return null;
    return {
      version: 1,
      token: parsed.token,
      clearedAt: typeof parsed.clearedAt === "string" ? parsed.clearedAt : "",
      ...(typeof parsed.v1Fingerprint === "string" && {
        v1Fingerprint: parsed.v1Fingerprint,
      }),
    };
  } catch {
    return null;
  }
};

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
  fingerprint?: string;
  afterClear?: string;
}): ThreadFileV2 => ({
  version: 2,
  threadId: input.threadId,
  updatedAt: input.updatedAt,
  source: {
    kind: "transcript-v1",
    updatedAt: input.updatedAt,
    segments: input.segments.length,
    ...(input.fingerprint !== undefined && { fingerprint: input.fingerprint }),
    ...(input.afterClear !== undefined && { afterClear: input.afterClear }),
  },
  messages: v1ToUiMessages(input.segments),
});

// ─── v2, as far as the conversion rules need it ─────────────────────────────

/** What the rules read from an existing v2 file. */
export type ThreadTwin =
  | { status: "missing" }
  /** It exists but could not be read (EACCES, EBUSY, …): never replaced. */
  | { status: "unreadable" }
  /** Unparseable JSON, or not a v2 file this code can classify. */
  | { status: "corrupt" }
  /**
   * A thread file from a newer build (a `version` above 2, or a `source.kind`
   * this build does not know): never replaced, never archived over.
   */
  | { status: "foreign" }
  | { status: "ok"; source: ThreadSource; file: ThreadFileV2 };

/** A twin as the migration steps keep it: the source only, not the file. */
export type ThreadTwinSummary =
  | Exclude<ThreadTwin, { status: "ok" }>
  | { status: "ok"; source: ThreadSource };

const afterClearOf = (source: Record<string, unknown>) =>
  typeof source.afterClear === "string"
    ? { afterClear: source.afterClear }
    : {};

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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { status: "corrupt" };
  const file = parsed as Record<string, unknown>;
  if (typeof file.version === "number" && file.version > 2)
    return { status: "foreign" };
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
        ...afterClearOf(source),
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
        ...(typeof source.fingerprint === "string" && {
          fingerprint: source.fingerprint,
        }),
        ...afterClearOf(source),
      },
      file: parsed as ThreadFileV2,
    };
  return typeof source.kind === "string" && source.kind !== "transcript-v1"
    ? { status: "foreign" }
    : { status: "corrupt" };
};

/** `a >= b` for two ISO times; by string when either does not parse. */
export const isSameOrNewer = (a: string, b: string): boolean => {
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isNaN(left) || Number.isNaN(right) ? a >= b : left >= right;
};

/** What the rules know about a v1 file. */
export interface V1Meta {
  updatedAt: string;
  /** Set by every caller that read the bytes. */
  fingerprint?: string;
}

/**
 * Whether a v1-derived twin holds exactly this v1 file: by fingerprint when
 * both have one, by time only for a twin written before fingerprints.
 */
export const twinMatchesV1 = (
  source: Extract<ThreadSource, { kind: "transcript-v1" }>,
  v1: V1Meta
): boolean =>
  source.fingerprint !== undefined && v1.fingerprint !== undefined
    ? source.fingerprint === v1.fingerprint
    : isSameOrNewer(source.updatedAt, v1.updatedAt);

export type ConversionDecision =
  | { action: "convert"; kind: "create" | "replace-derived" | "replace-user" }
  | {
      action: "skip";
      reason: "agui" | "up-to-date" | "foreign" | "unreadable";
    };

/**
 * Convert when the twin is missing, unparseable, or v1-derived from other
 * bytes than the v1 file's; never over `agui`, a newer build's file, or a
 * file that could not be read. An unparseable twin is replaced as
 * `replace-user`: it is most likely garbage, but nothing proves it derived.
 */
export const decideConversion = (
  v1: V1Meta,
  twin: ThreadTwin | ThreadTwinSummary
): ConversionDecision => {
  switch (twin.status) {
    case "missing":
      return { action: "convert", kind: "create" };
    case "corrupt":
      return { action: "convert", kind: "replace-user" };
    case "foreign":
    case "unreadable":
      return { action: "skip", reason: twin.status };
    case "ok":
      if (twin.source.kind === "agui")
        return { action: "skip", reason: "agui" };
      return twinMatchesV1(twin.source, v1)
        ? { action: "skip", reason: "up-to-date" }
        : { action: "convert", kind: "replace-derived" };
  }
};

// ─── The schemas (tests and debugging; the rules above never need them) ─────

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
const ToolCallState = v.picklist([
  "awaiting-input",
  "input-streaming",
  "input-complete",
  "approval-requested",
  "approval-responded",
  "complete",
  "error",
]);
const Approval = v.object({
  id: v.string(),
  needsApproval: v.boolean(),
  approved: v.optional(v.boolean()),
});
const ToolCallPartSchema = v.looseObject({
  type: v.literal("tool-call"),
  id: v.string(),
  name: v.string(),
  arguments: v.string(),
  state: ToolCallState,
  approval: v.optional(Approval),
  metadata: Meta,
});
const ResultState = v.picklist(["streaming", "complete", "error"]);
const ResultOutcome = v.optional(v.picklist(["cancelled", "denied"]));
const ToolResultPartSchema = v.looseObject({
  type: v.literal("tool-result"),
  id: v.optional(v.string()),
  toolCallId: v.string(),
  content: v.union([v.string(), v.array(v.unknown())]),
  state: ResultState,
  outcome: ResultOutcome,
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

const SubagentStatus = v.picklist([
  "running",
  "finished",
  "error",
  "suspended",
]);

const SubagentPartSchema: v.GenericSchema<unknown> = v.looseObject({
  type: v.literal("subagent"),
  subagent: v.looseObject({
    id: v.string(),
    name: v.string(),
    status: SubagentStatus,
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

const TranscriptV1Source = v.object({
  kind: v.literal("transcript-v1"),
  updatedAt: v.string(),
  segments: v.number(),
  fingerprint: v.optional(v.string()),
  afterClear: v.optional(v.string()),
});

export const ThreadFileV2Schema = v.looseObject({
  version: v.literal(2),
  threadId: v.string(),
  updatedAt: v.string(),
  source: v.variant("kind", [
    TranscriptV1Source,
    v.looseObject({
      kind: v.literal("agui"),
      migratedFrom: v.optional(v.object({ updatedAt: v.string() })),
      afterClear: v.optional(v.string()),
    }),
  ]),
  messages: v.array(UIMessageSchema),
  runs: v.optional(v.array(v.unknown())),
});

// ─── The strict schema of a file the v1 mapper wrote (C-T2) ─────────────────

const Str = v.string();
const OptStr = v.optional(Str);
const OptNum = v.optional(v.number());

/** `metadata.abacus` of a part that carries its segment id (C.3). */
const Tagged = (entries: v.ObjectEntries = {}) =>
  v.strictObject({
    abacus: v.strictObject({ segmentId: Str, ...entries }),
  });

const ProvenanceSchema = v.strictObject({
  id: Str,
  type: Str,
  at: OptNum,
  partIndex: v.nullable(v.number()),
  groupId: OptStr,
  title: OptStr,
  category: OptStr,
  summary: OptStr,
  status: OptStr,
  outcome: OptStr,
  messageIndex: OptNum,
  regenerateAttempt: OptNum,
  versions: v.optional(v.unknown()),
  supersededBy: OptStr,
  raw: v.optional(v.unknown()),
  extra: v.optional(v.record(Str, v.unknown())),
});

const MessageAbacus = v.strictObject({
  segments: v.array(ProvenanceSchema),
  messageIndex: OptNum,
  regenerateAttempt: OptNum,
  versions: v.optional(v.unknown()),
  credits: v.optional(
    v.array(v.strictObject({ segmentId: Str, creditsUsed: v.number() }))
  ),
  userText: v.optional(
    v.strictObject({
      routineFire: v.optional(v.literal(true)),
      systemReminder: v.optional(v.literal(true)),
      attachments: v.optional(
        v.array(v.strictObject({ path: Str, name: Str, mimeType: OptStr }))
      ),
    })
  ),
  feedback: v.optional(v.strictObject({ segmentId: Str, index: v.number() })),
});

const KIND_TEXT = v.strictObject({
  type: v.literal("text"),
  content: Str,
  metadata: v.strictObject({
    abacus: v.looseObject({
      segmentId: Str,
      kind: v.picklist([
        "collapsible",
        "notification",
        "web_search_results",
        "feature_limit",
        "compaction",
        "unknown",
      ]),
    }),
  }),
});

const MigratedPart: v.GenericSchema<unknown> = v.union([
  v.strictObject({ type: v.literal("text"), content: Str, metadata: Tagged() }),
  KIND_TEXT,
  v.strictObject({ type: v.literal("thinking"), content: Str, stepId: Str }),
  v.strictObject({
    type: v.literal("tool-call"),
    id: Str,
    name: v.pipe(Str, v.minLength(1)),
    arguments: Str,
    state: ToolCallState,
    approval: v.optional(Approval),
    metadata: Tagged({
      callId: OptStr,
      endpoint: OptStr,
      status: OptStr,
      legacy: v.optional(v.record(Str, v.unknown())),
    }),
  }),
  v.strictObject({
    type: v.literal("tool-result"),
    id: Str,
    toolCallId: Str,
    content: Str,
    state: ResultState,
    outcome: ResultOutcome,
    error: OptStr,
    metadata: v.strictObject({
      abacus: v.strictObject({
        data: v.optional(v.record(Str, v.unknown())),
        rejection: v.optional(v.record(Str, v.unknown())),
        synthesised: v.optional(v.literal(true)),
      }),
    }),
  }),
  v.strictObject({
    type: v.literal("image"),
    source: v.strictObject({ type: v.literal("url"), value: Str }),
    metadata: Tagged({
      width: OptNum,
      height: OptNum,
      prompt: OptStr,
      model: OptStr,
    }),
  }),
  v.strictObject({
    type: v.literal("video"),
    source: v.strictObject({ type: v.literal("url"), value: Str }),
    metadata: Tagged({
      width: OptNum,
      height: OptNum,
      prompt: OptStr,
      model: OptStr,
      aspectRatio: OptStr,
      duration: OptNum,
      loop: v.boolean(),
    }),
  }),
  v.strictObject({
    type: v.literal("subagent"),
    subagent: v.strictObject({
      id: Str,
      name: Str,
      description: OptStr,
      status: v.picklist(["running", "finished", "error"]),
      error: v.optional(v.strictObject({ message: Str })),
      messages: v.pipe(v.array(v.lazy(() => MigratedMessage)), v.minLength(1)),
      metadata: v.strictObject({
        abacus: v.strictObject({
          startTime: OptNum,
          endTime: OptNum,
          segmentId: OptStr,
          segments: v.optional(v.array(ProvenanceSchema)),
        }),
      }),
    }),
  }),
]);

const MigratedMessage: v.GenericSchema<unknown> = v.strictObject({
  id: Str,
  role: v.picklist(["user", "assistant"]),
  parts: v.array(MigratedPart),
  metadata: v.strictObject({
    abacus: MessageAbacus,
    tanstack: v.optional(v.strictObject({ createdAt: Str })),
  }),
});

/** A file the v1 mapper wrote: every part and metadata shape checked. */
export const MigratedThreadFileV2Schema = v.strictObject({
  version: v.literal(2),
  threadId: Str,
  updatedAt: Str,
  source: TranscriptV1Source,
  messages: v.array(MigratedMessage),
});
