/**
 * The one path from a failure to what the user reads. Text written for the
 * user is shown as it is; an internal failure (an exception, a server's
 * body, a status, command output) never is: the page shows the app's copy
 * for a reason it knows, else its own calm line, and the detail is logged.
 *
 * Written for the user, by type, never by guessing at the text:
 * - a `UserFacingError` the renderer throws with its own translated copy;
 * - a contract error main marks `data.userFacing` (an `InvalidInputError`, a
 *   cron schedule's detail, gh's own plain sentence);
 * - a `{ success: false, error, userFacing: true }` answer.
 */
import { isDefinedError } from "@orpc/client";
import { isCancelledError } from "@tanstack/react-query";

import { isHostUnavailable } from "#renderer/data/transport/lifecycle";
import { i18n } from "#renderer/lib/i18n";

/** A failure whose message the renderer wrote for the user, translated. */
export class UserFacingError extends Error {
  override name = "UserFacingError";
}

/**
 * A failure as a page keeps it until it shows it: a code (or main's text)
 * it words with `errorText`, or main's sentence for the user.
 */
export type ShownFailure = string | UserFacingError;

/** An `{ ok: false }` outcome's error, kept with whether main wrote it for the user. */
export const outcomeFailure = (outcome: {
  error: string;
  userFacing?: boolean;
}): ShownFailure =>
  outcome.userFacing === true
    ? new UserFacingError(outcome.error)
    : outcome.error;

/** A procedure's `{ success: false }` answer, as a mutation's error. */
export class FailedAnswer extends Error {
  constructor(
    readonly reason: string | undefined,
    readonly userFacing = false
  ) {
    super(reason ?? "failed");
  }
}

/**
 * Cancelled by the app itself (an unmount, a superseded or refetched read,
 * an aborted call): not a failure, so never shown as one.
 */
export const isCancellation = (error: unknown): boolean =>
  isCancelledError(error) ||
  (error as { name?: unknown } | null)?.name === "AbortError";

/** Main could not save anything: the computer's disk is full. */
const isDiskFull = (error: unknown): boolean => {
  if (!isDefinedError(error)) return false;
  const { code, data } = error as { code?: unknown; data?: unknown };
  return (
    code === "PRECONDITION_FAILED" &&
    (data as { reason?: unknown } | undefined)?.reason === "disk-full"
  );
};

/** Reason codes the app answers with, and the copy each shows. */
const REASON_COPY: Readonly<Record<string, string>> = {
  "popup-blocked": "phase5.popupBlocked",
  timeout: "phase5.connectTimedOut",
  failed: "phase5.connectFailed",
  unreachable: "phase5.connectUnreachable",
  // A connector whose server ships in another app (Roblox Studio).
  "app-missing": "phase5.connectAppMissing",
  "app-not-ready": "phase5.connectAppNotReady",
  "other-os": "phase5.connectOtherOs",
  "host-unavailable": "chat.message.notSent",
  "disk-full": "errors.diskFull",
};

/** The reason code an answer carries, if it is one the app has copy for. */
const reasonCode = (error: unknown): string | undefined => {
  // Only an answer's own code: an exception's message is never a code.
  const reason =
    typeof error === "string"
      ? error
      : error instanceof FailedAnswer
        ? error.reason
        : undefined;
  return reason != null && Object.hasOwn(REASON_COPY, reason)
    ? reason
    : undefined;
};

/** A failure's text when it was written for the user, else undefined. */
const userText = (error: unknown): string | undefined => {
  if (error instanceof UserFacingError) return error.message;
  if (error instanceof FailedAnswer)
    return error.userFacing ? error.reason : undefined;
  if (!isDefinedError(error)) return undefined;
  const { data, message } = error as { data?: unknown; message?: unknown };
  return (data as { userFacing?: unknown } | undefined)?.userFacing === true &&
    typeof message === "string"
    ? message
    : undefined;
};

/** What a caught failure is, as a code the page translates when it shows it. */
export const failureCode = (
  error: unknown
): "cancelled" | "host-unavailable" | "disk-full" | "failed" => {
  if (isCancellation(error)) return "cancelled";
  if (isHostUnavailable(error)) return "host-unavailable";
  if (isDiskFull(error)) return "disk-full";
  logFailure(error);
  return "failed";
};

/** Failures already logged: the same one can come through more than once. */
const logged = new Set<unknown>();
/** Logs a failure's detail once. Never call it while rendering. */
export const logFailure = (error: unknown): void => {
  if (logged.has(error)) return;
  logged.add(error);
  if (logged.size > 100) logged.delete(logged.values().next().value);
  console.error("[error]", error);
};

/** Null: nothing to show. `known`: the app has words for it (no log needed). */
const describe = (
  error: unknown,
  fallback: string
): { text: string | null; known: boolean } => {
  if (isCancellation(error) || error === "cancelled")
    return { text: null, known: true };
  // Never reached the host: one "not sent", whichever write it was.
  if (isHostUnavailable(error))
    return { text: i18n.t("chat.message.notSent"), known: true };
  // Every write fails the same way, so the cause outranks the site's copy.
  if (isDiskFull(error))
    return { text: i18n.t("errors.diskFull"), known: true };
  const written = userText(error);
  if (written != null && written !== "") return { text: written, known: true };
  const code = reasonCode(error);
  if (code != null) return { text: i18n.t(REASON_COPY[code]!), known: true };
  return { text: i18n.t(fallback), known: false };
};

/**
 * What the user reads for `error`; null shows nothing. Pure, so a page may
 * call it while rendering. `fallback` is the site's copy for a failure the
 * app has no words for ("Something went wrong. Try again." by default).
 */
export const errorText = (
  error: unknown,
  fallback = "errors.tryAgain"
): string | null => describe(error, fallback).text;

/** `errorText` for a failure just caught: an internal one is logged. */
export const failureText = (
  error: unknown,
  fallback = "errors.tryAgain"
): string | null => {
  const { text, known } = describe(error, fallback);
  if (!known) logFailure(error);
  return text;
};
