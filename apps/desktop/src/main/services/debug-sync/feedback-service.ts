/**
 * A verdict on one assistant turn, reported to the platform: a thumbs
 * up/down on a reply, or the chat's rating line (rating-prompt.ts) on its
 * latest reply. The verdict is keyed on the synced transcript (session +
 * event sequence), so the transcript is flushed first and the rated segment
 * is named by the sequence it was uploaded under.
 */
import {
  CHAT_RATINGS,
  type ChatRating,
  RATING_COMMENT_MAX,
  RATING_TASK_TYPES,
  type RatingTaskType,
  redactContactDetails,
} from "@abacus-ai/contract/rating-prompt";
import { PROVIDER_ENV_VARS } from "@abacus-ai/contract/settings";
import { app } from "electron";

import { readSettings } from "../config/settings";
import { clientEnvironment } from "../diagnostics/client-environment";
import { abacusRoutellmV1 } from "../providers/abacus-host";
import type { DebugSyncService } from "./debug-sync-service";

export type FeedbackRating = "up" | "down" | "clear";

export interface TurnFeedback {
  sessionId: string;
  /** The rated bot text segment. */
  segmentId: string;
  rating: FeedbackRating;
  comment?: string;
  /** The model the turn ran on, for the alert. */
  model?: string | null;
}

export interface FeedbackOutcome {
  ok: boolean;
  /** Why not, in the platform's words; the renderer shows a generic line. */
  reason?: string;
  /** Not taken, but worth sending again later (busy, a server error, no network). */
  retryable?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** The platform's cap; anything longer is cut there anyway. */
const MAX_COMMENT_LENGTH = 2000;
const MAX_MODEL_LENGTH = 200;
/** Same shape the transcript sync uses for session ids. */
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_SEGMENT_ID_LENGTH = 256;
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
  const segmentId = raw.segmentId;
  const rating = raw.rating;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
  if (
    typeof segmentId !== "string" ||
    segmentId.length === 0 ||
    segmentId.length > MAX_SEGMENT_ID_LENGTH
  )
    return null;
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
    segmentId,
    rating: rating as FeedbackRating,
    ...(comment.length > 0 ? { comment } : {}),
    model,
  };
};

export interface ChatRatingVerdict {
  sessionId: string;
  segmentId: string;
  ratingId: string;
  rating: ChatRating;
  comment?: string;
  taskType: RatingTaskType;
  turns: number;
  locale: string | null;
  model?: string | null;
}

const RATING_ID = /^[A-Za-z0-9-]{8,64}$/;
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;

/**
 * The chat rating the platform will see, checked here as a thumb is. The
 * comment loses any email address or phone number before it leaves.
 */
export const sanitizeChatRating = (
  input: unknown
): ChatRatingVerdict | null => {
  if (typeof input !== "object" || input == null) return null;
  const raw = input as Record<string, unknown>;
  const { sessionId, segmentId, ratingId, rating, taskType, turns } = raw;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
  if (
    typeof segmentId !== "string" ||
    segmentId.length === 0 ||
    segmentId.length > MAX_SEGMENT_ID_LENGTH
  )
    return null;
  if (typeof ratingId !== "string" || !RATING_ID.test(ratingId)) return null;
  if (!CHAT_RATINGS.includes(rating as ChatRating)) return null;
  if (!RATING_TASK_TYPES.includes(taskType as RatingTaskType)) return null;
  if (typeof turns !== "number" || !Number.isInteger(turns) || turns < 1)
    return null;
  const comment =
    typeof raw.comment === "string"
      ? redactContactDetails(raw.comment.trim().slice(0, RATING_COMMENT_MAX))
      : "";
  const locale =
    typeof raw.locale === "string" && LOCALE.test(raw.locale)
      ? raw.locale
      : null;
  const model =
    typeof raw.model === "string" && raw.model.length > 0
      ? raw.model.slice(0, MAX_MODEL_LENGTH)
      : null;
  return {
    sessionId,
    segmentId,
    ratingId,
    rating: rating as ChatRating,
    ...(comment.length > 0 ? { comment } : {}),
    taskType: taskType as RatingTaskType,
    turns,
    locale,
    model,
  };
};

export class FeedbackService {
  constructor(
    private readonly options: {
      debugSync: Pick<DebugSyncService, "flush" | "sequenceOf">;
      clientVersion: string;
      fetchImpl?: typeof fetch;
    }
  ) {}

  /**
   * `<routellm base>/abacusaibot_feedback`, with a dev-only override. Never
   * in a packaged build: the post carries the Abacus key, and an env var an
   * attacker set must not redirect a signed app to their collector.
   */
  private url(): string {
    const override = (process.env.ABACUSAI_BOT_FEEDBACK_URL ?? "").trim();
    if (override.length > 0 && !app.isPackaged) return override;
    return `${abacusRoutellmV1()}/abacusaibot_feedback`;
  }

  async submit(input: unknown): Promise<FeedbackOutcome> {
    const feedback = sanitizeFeedback(input);
    if (feedback == null) return { ok: false, reason: "invalid" };
    return this.post(feedback.sessionId, feedback.segmentId, {
      rating: feedback.rating,
      comment: feedback.comment ?? "",
      model: feedback.model ?? null,
    });
  }

  /** The chat's rating line, on the same endpoint as a thumb. */
  async rate(input: unknown): Promise<FeedbackOutcome> {
    const verdict = sanitizeChatRating(input);
    if (verdict == null)
      return { ok: false, reason: "invalid", retryable: false };
    return this.post(verdict.sessionId, verdict.segmentId, {
      rating: verdict.rating,
      rating_id: verdict.ratingId,
      comment: verdict.comment ?? "",
      task_type: verdict.taskType,
      turns: verdict.turns,
      locale: verdict.locale,
      model: verdict.model ?? null,
    });
  }

  /** Flushes the session, names the segment's sequence, and posts `body`. */
  private async post(
    sessionId: string,
    segmentId: string,
    body: Record<string, unknown>
  ): Promise<FeedbackOutcome> {
    const key = readSettings().apiKeys?.[PROVIDER_ENV_VARS.abacus];
    if (key == null || key.trim().length === 0)
      return { ok: false, reason: "no-key", retryable: false };

    // The server rates a synced event; make sure this turn is one.
    await this.options.debugSync.flush(sessionId);
    const sequence = this.options.debugSync.sequenceOf(sessionId, segmentId);
    if (sequence == null)
      return { ok: false, reason: "not-synced", retryable: true };

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
          session_id: sessionId,
          event_sequence_number: sequence,
          ...body,
          platform: clientEnvironment().os_name,
          client_version: this.options.clientVersion,
        }),
        signal: controller.signal,
      });
      if (response.ok) return { ok: true };
      // Busy or a server error may clear up; anything else is the server's
      // final answer (a bad request, a limit reached).
      const retryable = response.status === 409 || response.status >= 500;
      let reason = `http-${response.status}`;
      try {
        const answer = (await response.json()) as { error?: unknown };
        if (typeof answer.error === "string") reason = answer.error;
      } catch {
        // The status is reason enough.
      }
      return { ok: false, reason, retryable };
    } catch (error) {
      return {
        ok: false,
        retryable: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
