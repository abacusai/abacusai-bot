import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import type { SessionOwner } from "../contracts";
import { MESSAGE_REACTION_EMOJIS } from "../message-reactions";
import type { ChatHydrationResult, StreamChunk } from "./agui";
import type { AiThreadSnapshot } from "./ai-thread";
import { mutation, query, subscription } from "./base";
import { SessionId } from "./ids";

/**
 * A UI message as the AG-UI client sends it. Main does not re-validate the
 * parts deeply: the agent child owns the message semantics.
 */
export const UIMessageLoose = v.looseObject({
  id: v.string(),
  role: v.picklist(["system", "user", "assistant"]),
  parts: v.array(v.looseObject({ type: v.string() })),
});

/** An interrupt resume entry (`RunAgentResumeItem`), loosely. */
export const ResumeItem = v.looseObject({
  interruptId: v.pipe(v.string(), v.nonEmpty()),
  status: v.picklist(["resolved", "cancelled"]),
});

/** A client-side tool the renderer offers the run. */
export const ClientTool = v.looseObject({
  name: v.string(),
});

export const AiSendInputSchema = v.object({
  threadId: SessionId,
  startId: v.optional(SessionId),
  runId: v.pipe(v.string(), v.nonEmpty()),
  parentRunId: v.optional(v.string()),
  messages: v.array(UIMessageLoose),
  resume: v.optional(v.array(ResumeItem)),
  forwardedProps: v.optional(v.record(v.string(), v.unknown())),
  clientTools: v.optional(v.array(ClientTool)),
});

export type AiSendInput = v.InferOutput<typeof AiSendInputSchema>;

/**
 * The agent's `run.ack` for one run id (spec 02 §14.5). A repeated `ai.send`
 * with a run id main has seen answers `duplicate`, with the first answer's
 * status in `original`, and writes nothing to the agent.
 */
export interface AiSendAck {
  runId: string;
  status: "started" | "queued" | "rejected" | "duplicate";
  original?: "started" | "queued" | "rejected";
  reason?: "regenerate_unsupported" | "empty" | "resume_unsupported";
  /** `queued`: the host queue entry the text went into. */
  entryId?: string;
}

/**
 * One `PermissionDecision` (agent `protocol.ts`), validated strictly: a
 * boolean or `{approved}` is a bad request, never coerced to a rejection.
 */
export const PermissionDecisionSchema = v.union([
  v.picklist(["accept", "reject", "background", "allowAlways", "allowYolo"]),
  v.strictObject({
    type: v.literal("accept_with_message"),
    message: v.string(),
  }),
  v.strictObject({
    type: v.literal("reject_with_message"),
    message: v.string(),
  }),
  v.strictObject({
    type: v.literal("question_answers"),
    answers: v.record(v.string(), v.string()),
  }),
  v.strictObject({
    type: v.literal("allow_always_with_rule"),
    rule: v.string(),
  }),
  v.strictObject({
    type: v.literal("allow_always_with_rules"),
    rules: v.array(v.string()),
  }),
]);

/** Which pending permission an answer is for (agent spec §3.5.3). */
export const PermissionLineageSchema = v.strictObject({
  threadId: v.pipe(v.string(), v.nonEmpty()),
  incarnation: v.pipe(v.string(), v.nonEmpty()),
  turnSeq: v.pipe(v.number(), v.integer(), v.minValue(0)),
  runId: v.optional(v.string()),
  permissionId: v.pipe(v.string(), v.nonEmpty()),
});

const QueueEntryId = v.pipe(v.string(), v.nonEmpty());
const Incarnation = v.pipe(v.string(), v.nonEmpty());

/**
 * `ai.hydrate`: TanStack's hydration result plus the session-scoped state the
 * chat kit keeps (spec 02 §14.1), all read in one relay turn.
 */
export interface AiHydration extends ChatHydrationResult {
  abacus: AiThreadSnapshot;
}

/** The agent's silent answer: a reply the user never sees (the bot loop's). */
export const NO_REPLY = "NO_REPLY";

/**
 * Assistant text as the user sees it: a trailing `NO_REPLY` and the
 * whitespace around it removed, so exactly `NO_REPLY` reads as "".
 */
export const withoutNoReply = (text: string): string => {
  const trimmed = text.trimEnd();
  return trimmed.endsWith(NO_REPLY)
    ? trimmed.slice(0, -NO_REPLY.length).trimEnd()
    : text;
};

/**
 * What a routine with an end condition ends its run's reply on when the
 * condition holds: the app then retires the routine. Never shown to the user.
 */
export const ROUTINE_DONE = "ROUTINE_DONE";

/** The reply without a trailing `ROUTINE_DONE`, or as it was when it has none. */
export const withoutRoutineDone = (text: string): string => {
  const trimmed = text.trimEnd();
  return trimmed.endsWith(ROUTINE_DONE)
    ? trimmed.slice(0, -ROUTINE_DONE.length).trimEnd()
    : text;
};

/** The mark a hand-off step ends on when nothing is left to do; the app reads it, the user never sees it. */
const CHAIN_DONE_TAG = /<chain_done\s*\/?>(?:\s*<\/chain_done>)?/gi;

/** The reply without a hand-off step's `<chain_done/>` mark. */
export const withoutChainDone = (text: string): string => {
  const out = text.replace(CHAIN_DONE_TAG, "");
  return out === text ? text : out.trimEnd();
};

/**
 * A run's end, once per run id, from the relay's authoritative terminal
 * (spec 03 §24.11): the first terminal of the run, main's own
 * (`agent_exit`, `agent_crashed`, `inactivity_timeout`) included; never
 * from compat `turn_complete` or a provisional idle. Command errors are not
 * runs and publish nothing. Its event id is the terminal's relay seq.
 */
export interface RunFinishedNotice {
  threadId: string;
  runId: string;
  outcome: "success" | "cancelled" | "error";
  /** `outcome: "error"`: the terminal's code, when it has one. */
  errorCode?: string;
  /**
   * The run's assistant messages hold a text part that is not blank once
   * `withoutNoReply` has removed a trailing `NO_REPLY`.
   */
  hasVisibleAssistantText: boolean;
  owner: SessionOwner | null;
  routineId: string | null;
  at: number;
}

/**
 * One thread's answerable permissions (spec 06 §11.2): its live
 * incarnation's `permission.pending`, never with zero counts.
 */
export interface AttentionSummary {
  threadId: string;
  /** The agent's opaque incarnation string (`AiThreadSnapshot.incarnation`). */
  incarnation: string;
  questions: number;
  approvals: number;
  /** When main first saw the oldest of them (epoch ms). */
  oldestAt: number;
  /** The oldest one's message. */
  firstTitle: string | null;
  /** Full lineage of the oldest descriptor, for local descriptor snoozes. */
  firstDescriptorId?: string;
}

/**
 * `ai.attention`: a snapshot taken atomically with registration, then
 * revisioned changes (one monotonic revision per relay process). No resume:
 * a reconnect starts from a fresh snapshot.
 */
export type AttentionEvent =
  | { type: "snapshot"; revision: number; items: AttentionSummary[] }
  | { type: "upsert"; revision: number; item: AttentionSummary }
  | { type: "remove"; revision: number; threadId: string };

/**
 * The AG-UI conversation (spec 00 A.3, spec 02 §14). The thread id is the
 * session id. Main serves every one of these from its AG-UI relay.
 */
export const ai = {
  /**
   * Every thread's run ends (spec 03 §24.11), lossless-actionable (10,000
   * pending, then `RESYNC_REQUIRED`). Each carries its event id, so
   * `lastEventId` resumes from the relay's bounded notice ring; a resume
   * point the ring no longer holds replays what it still has.
   */
  runFinished: subscription
    .input(v.object({ lastEventId: v.optional(v.string()) }))
    .output(eventIterator(type<RunFinishedNotice>())),
  /**
   * Which threads wait on the user and how (spec 06 §11.2): first yield a
   * `snapshot`, then `upsert`/`remove` with increasing revisions.
   * Lossless-actionable; an overflow ends it with `RESYNC_REQUIRED` and the
   * client resubscribes.
   */
  attention: subscription
    .input(v.object({}))
    .output(eventIterator(type<AttentionEvent>())),
  /**
   * Replay after `lastEventId` (events with a greater seq), then live. The
   * first yield is always `CUSTOM abacus.subscribed`; a resume point the ring
   * no longer holds, or one from another relay `epoch` (the checkpoint's
   * `abacus.epoch`, which a resume should carry), starts with
   * `CUSTOM abacus.resync`. Neither carries an event id. Never returns by
   * itself. `NOT_FOUND` for an unknown thread.
   */
  subscribe: subscription
    .input(
      v.object({
        threadId: SessionId,
        lastEventId: v.optional(v.string()),
        epoch: v.optional(v.string()),
      })
    )
    .output(eventIterator(type<StreamChunk>())),
  /**
   * Writes the agent's `run` and resolves with its `run.ack` for this run id.
   * Idempotent by run id across agent incarnations. `BAD_REQUEST`,
   * `NOT_FOUND` and `UNAVAILABLE` are raised only before `run` is written.
   */
  react: mutation
    .input(
      v.object({
        threadId: SessionId,
        messageId: v.pipe(v.string(), v.nonEmpty()),
        emoji: v.picklist(MESSAGE_REACTION_EMOJIS),
        selected: v.boolean(),
      })
    )
    .output(type<void>()),
  send: mutation.input(AiSendInputSchema).output(type<AiSendAck>()),
  /**
   * The completed transcript (excluding the active run's messages), the
   * active run, and the session-scoped state at one relay seq (`abacus.cursor`,
   * the thread's own last seq). `NOT_FOUND` for an unknown thread, and for a
   * `before` cursor the transcript does not hold.
   */
  hydrate: query
    .input(
      v.object({
        threadId: SessionId,
        limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
        before: v.optional(v.string()),
      })
    )
    .output(type<AiHydration>()),
  /**
   * Every relay event of the run's thread from its `RUN_STARTED` through its
   * terminal, then returns. An unknown or evicted run returns at once.
   */
  joinRun: subscription
    .input(v.object({ runId: v.pipe(v.string(), v.nonEmpty()) }))
    .output(eventIterator(type<StreamChunk>())),
  /**
   * `cancel {runId}` to the agent: applied to the open run or the admission
   * that will open it, ignored for a stale id. Without `runId`, an
   * unconditional Stop. The run closes with `RUN_FINISHED{cancelled}`.
   */
  cancel: mutation
    .input(v.object({ threadId: SessionId, runId: v.optional(v.string()) }))
    .output(type<void>()),
  /**
   * One permission answer (`permission.respond`). The outcome arrives on the
   * stream: `permission.resolved` or `permission.response_rejected`.
   */
  respondPermission: mutation
    .input(
      v.object({
        threadId: SessionId,
        lineage: PermissionLineageSchema,
        decision: PermissionDecisionSchema,
      })
    )
    .output(type<void>()),
  /**
   * Stop one task still running past its turn (a background job or a served
   * page) by its `background.tasks` id. The next `background.tasks` on the
   * stream is the answer.
   */
  stopTask: mutation
    .input(
      v.object({ threadId: SessionId, id: v.pipe(v.string(), v.maxLength(64)) })
    )
    .output(type<void>()),
  /**
   * The agent's host queue, which is authoritative (agent spec §3.1.6). Entry
   * ids are per agent process, so an edit or removal names the incarnation
   * it was read from; the agent checks both and finds the entry by id in one
   * step (spec 02 §14.6). A mismatch or a gone entry is answered on the
   * stream with `CUSTOM queue.command_rejected` and changes nothing.
   */
  queue: {
    enqueue: mutation
      .input(
        v.object({
          threadId: SessionId,
          message: v.string(),
          userText: v.optional(
            v.object({
              replyTo: v.optional(
                v.object({
                  messageId: v.string(),
                  role: v.picklist(["user", "assistant"]),
                  excerpt: v.string(),
                })
              ),
              visibleFrom: v.optional(
                v.pipe(v.number(), v.integer(), v.minValue(0))
              ),
            })
          ),
        })
      )
      .output(type<void>()),
    update: mutation
      .input(
        v.object({
          threadId: SessionId,
          incarnation: Incarnation,
          entryId: QueueEntryId,
          message: v.string(),
        })
      )
      .output(type<void>()),
    remove: mutation
      .input(
        v.object({
          threadId: SessionId,
          incarnation: Incarnation,
          entryId: QueueEntryId,
        })
      )
      .output(type<void>()),
    clear: mutation
      .input(v.object({ threadId: SessionId }))
      .output(type<void>()),
    /** "Send now": the head of the queue runs (or steers) at once. */
    dequeue: mutation
      .input(v.object({ threadId: SessionId }))
      .output(type<void>()),
  },
};
