/**
 * The one path from a failure to what the user reads. A page never shows an
 * error's own words (an exception, main's or a server's message, a status,
 * command output): it shows the app's copy for a reason it knows, else a
 * calm generic line, and the detail goes to the log.
 */
import { isDefinedError } from "@orpc/client";
import { isCancelledError } from "@tanstack/react-query";

import { isHostUnavailable } from "#renderer/data/transport/lifecycle";
import { i18n } from "#renderer/lib/i18n";

/** A procedure's `{ success: false }` answer, as a mutation's error. */
export class FailedAnswer extends Error {
  constructor(readonly reason: string | undefined) {
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
  "disk-full": "errors.diskFull",
};

/** The reason code a failure carries, if it is one the app has copy for. */
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

/** Failures already logged: a page may ask for the same one's text each render. */
const logged = new Set<unknown>();
/** Logs a failure's detail once, for a page that shows its own words for it. */
export const logFailure = (error: unknown): void => {
  if (logged.has(error)) return;
  logged.add(error);
  if (logged.size > 100) logged.delete(logged.values().next().value);
  console.error("[error]", error);
};

/**
 * What the user reads for `error`; null shows nothing.
 * - one the app cancelled itself: nothing;
 * - never sent, a full disk, or a reason code the app knows: its copy;
 * - anything else: `fallback`'s copy (a site's own, else "Something went
 *   wrong. Try again."), the detail in the log, never on the page.
 */
export const errorText = (
  error: unknown,
  fallback = "errors.tryAgain"
): string | null => {
  if (isCancellation(error) || error === "cancelled") return null;
  // Never reached the host: one "not sent", whichever write it was.
  if (isHostUnavailable(error)) return i18n.t("chat.message.notSent");
  // Every write fails the same way, so the cause outranks the site's copy.
  if (isDiskFull(error)) return i18n.t("errors.diskFull");
  const code = reasonCode(error);
  if (code != null) return i18n.t(REASON_COPY[code]!);
  logFailure(error);
  return i18n.t(fallback);
};
