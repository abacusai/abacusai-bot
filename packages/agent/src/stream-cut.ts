/**
 * A reply Google closed partway: its stream ended before the last event was
 * whole. Both loops ask once more, out of sight, picking the reply up where
 * it stopped; if that is cut too, the turn ends on the cut-off card
 * (turn-outcome.ts). The card's Continue picks it up the same way.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { hostConnectivity } from "./connectivity.js";
import {
  continuePartialPrompt,
  dropFailedCall,
  failedCallStreamed,
  partialReplyText,
} from "./network-wait.js";

/**
 * The Gemini SDK's words for a stream that closed mid-event, and pi's for one
 * that closed without a finish reason. Matched only without an HTTP status:
 * a status is the provider answering, which has its own reading.
 */
const STREAM_CUT =
  /incomplete json segment at the end|google stream ended without a finish reason/i;

/** pi retries a stream with no finish reason itself; the silent ask is for the other. */
const PI_RETRIES = /ended without a finish reason/i;

/** Whether a failed call is Google cutting the reply off. */
export const isStreamCut = (
  raw: string,
  provider: string | undefined
): boolean =>
  provider === "gemini" && !/^\s*\d{3}\b/.test(raw) && STREAM_CUT.test(raw);

/**
 * What a loop does when a call on a model the user picked ended on `failure`:
 * null when it was no cut. While the machine is offline the cut is the
 * network's, waited out like any dropped connection; otherwise it is asked
 * once more out of sight (`ask`), or the turn ends on the cut-off card.
 */
export function streamCutStep(
  failure: string | null,
  provider: string | undefined,
  messages: readonly unknown[],
  askedThisTurn: number
): {
  kind: "network" | "ask" | "end";
  failure: string;
  streamed: boolean;
} | null {
  if (failure == null || !isStreamCut(failure, provider)) return null;
  const streamed = failedCallStreamed(messages);
  const connectivity = hostConnectivity();
  if (connectivity === "offline" || connectivity === "degraded")
    return { kind: "network", failure, streamed };
  return {
    kind: askedThisTurn === 0 && !PI_RETRIES.test(failure) ? "ask" : "end",
    failure,
    streamed,
  };
}

/** The hidden message that picks a cut reply up; never shown in the chat. */
export const STREAM_CUT_TYPE = "abacusai-bot:stream-cut";

const STREAM_CUT_LEAD =
  "Your previous reply was cut off by the provider partway through.";

const STREAM_CUT_REPLAY =
  "Your previous reply was cut off by the provider before any of it arrived. Carry on with the task from the transcript above. Do not restart work that already completed.";

/**
 * Pick the cut reply up: from the quoted tail of what arrived, or asked
 * again from the start when nothing did (or half a tool call did). What
 * arrived stays in the transcript either way.
 */
export function continueCutReply(session: AgentSession): Promise<void> {
  const partial = partialReplyText(session.messages);
  if (partial == null) dropFailedCall(session);
  return session.sendCustomMessage(
    {
      customType: STREAM_CUT_TYPE,
      content:
        partial != null
          ? continuePartialPrompt(STREAM_CUT_LEAD, partial)
          : STREAM_CUT_REPLAY,
      display: false,
    },
    { triggerTurn: true }
  );
}
