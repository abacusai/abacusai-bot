import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import type { ChatHydrationResult, StreamChunk } from "./agui";
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
  runId: v.pipe(v.string(), v.nonEmpty()),
  parentRunId: v.optional(v.string()),
  messages: v.array(UIMessageLoose),
  resume: v.optional(v.array(ResumeItem)),
  forwardedProps: v.optional(v.record(v.string(), v.unknown())),
  clientTools: v.optional(v.array(ClientTool)),
});

export type AiSendInput = v.InferOutput<typeof AiSendInputSchema>;

/**
 * The AG-UI conversation (spec 00 A.3). The thread id is the session id. Main
 * serves all five from an `AguiSource`; until the AG-UI emitter lands every
 * one of them answers `UNAVAILABLE`.
 */
export const ai = {
  /**
   * Replay from the resume point, then live. The first yield is always
   * `CUSTOM abacus.subscribed`; a resume point older than the replay ring
   * starts with `CUSTOM abacus.resync`. Never returns by itself.
   */
  subscribe: subscription
    .input(
      v.object({ threadId: SessionId, lastEventId: v.optional(v.string()) })
    )
    .output(eventIterator(type<StreamChunk>())),
  /** Resolves once the child accepted the run; events arrive on `subscribe`. */
  send: mutation.input(AiSendInputSchema).output(type<{ runId: string }>()),
  hydrate: query
    .input(
      v.object({
        threadId: SessionId,
        limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
        before: v.optional(v.string()),
      })
    )
    .output(type<ChatHydrationResult>()),
  /** From `RUN_STARTED`, then live; returns after `RUN_FINISHED`/`RUN_ERROR`. */
  joinRun: subscription
    .input(v.object({ runId: v.pipe(v.string(), v.nonEmpty()) }))
    .output(eventIterator(type<StreamChunk>())),
  /** Ends the run with `RUN_FINISHED{ outcome: "cancelled" }`. */
  cancel: mutation
    .input(v.object({ threadId: SessionId, runId: v.optional(v.string()) }))
    .output(type<void>()),
};
