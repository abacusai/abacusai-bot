/**
 * A thumbs up/down on one assistant turn, reported to the platform. The
 * verdict is keyed on the synced transcript (session + event index), so the
 * transcript is flushed first: a rating on a turn the server has not seen is
 * refused there, and would otherwise vanish.
 */
import { PROVIDER_ENV_VARS } from "#shared/settings";

import { readSettings } from "../config/settings";
import { clientEnvironment } from "../diagnostics/client-environment";
import { abacusRoutellmV1 } from "../providers/abacus-host";
import type { DebugSyncService } from "./debug-sync-service";

export type FeedbackRating = "up" | "down" | "clear";

export interface TurnFeedback {
  sessionId: string;
  /** Index of the rated bot text segment in the stored transcript. */
  eventSequenceNumber: number;
  rating: FeedbackRating;
  comment?: string;
  /** The model the turn ran on, for the alert. */
  model?: string | null;
}

export interface FeedbackOutcome {
  ok: boolean;
  /** Why not, in the platform's words; the renderer shows a generic line. */
  reason?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** The platform's cap; anything longer is cut there anyway. */
const MAX_COMMENT_LENGTH = 2000;
const MAX_MODEL_LENGTH = 200;
/** Same shape the transcript sync uses for session ids. */
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const RATINGS = new Set<FeedbackRating>(["up", "down", "clear"]);

/**
 * The request the platform will see, from what the renderer sent. Checked
 * here rather than trusted: this side holds the key, and the renderer is a
 * web page. Null when the input is not a rating of one of this user's turns.
 */
export const sanitizeFeedback = (input: unknown): TurnFeedback | null => {
  if (typeof input !== "object" || input == null) return null;
  const raw = input as Record<string, unknown>;
  const sessionId = raw.sessionId;
  const sequence = raw.eventSequenceNumber;
  const rating = raw.rating;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
  if (!Number.isInteger(sequence) || (sequence as number) < 0) return null;
  if (typeof rating !== "string" || !RATINGS.has(rating as FeedbackRating))
    return null;
  const comment =
    typeof raw.comment === "string"
      ? raw.comment.trim().slice(0, MAX_COMMENT_LENGTH)
      : "";
  const model =
    typeof raw.model === "string" && raw.model.length > 0
      ? raw.model.slice(0, MAX_MODEL_LENGTH)
      : null;
  return {
    sessionId,
    eventSequenceNumber: sequence as number,
    rating: rating as FeedbackRating,
    ...(comment.length > 0 ? { comment } : {}),
    model,
  };
};

export class FeedbackService {
  constructor(
    private readonly options: {
      debugSync: DebugSyncService;
      clientVersion: string;
      fetchImpl?: typeof fetch;
    }
  ) {}

  /** `<routellm base>/abacusaibot_feedback`, with a dev-only override. */
  private url(): string {
    const override = (process.env.ABACUSAI_BOT_FEEDBACK_URL ?? "").trim();
    if (override.length > 0) return override;
    return `${abacusRoutellmV1()}/abacusaibot_feedback`;
  }

  async submit(input: unknown): Promise<FeedbackOutcome> {
    const feedback = sanitizeFeedback(input);
    if (feedback == null) return { ok: false, reason: "invalid" };

    const key = readSettings().apiKeys?.[PROVIDER_ENV_VARS.abacus];
    if (key == null || key.trim().length === 0)
      return { ok: false, reason: "no-key" };

    // The server rates a synced event; make sure this turn is one.
    await this.options.debugSync.flush(feedback.sessionId);

    const doFetch = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await doFetch(this.url(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_id: feedback.sessionId,
          event_sequence_number: feedback.eventSequenceNumber,
          rating: feedback.rating,
          comment: feedback.comment ?? "",
          model: feedback.model ?? null,
          platform: clientEnvironment().os_name,
          client_version: this.options.clientVersion,
        }),
        signal: controller.signal,
      });
      if (response.ok) return { ok: true };
      let reason = `http-${response.status}`;
      try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body.error === "string") reason = body.error;
      } catch {
        // The status is reason enough.
      }
      return { ok: false, reason };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
