/**
 * A watched site's check, made by the app with no model call: a routine with
 * an `uptimeUrl` runs only when its site goes down or comes back, so a check
 * every few minutes costs nothing while nothing changes.
 */
import {
  UPTIME_FAILS_BEFORE_DOWN,
  type RoutineUptime,
} from "@abacus-ai/contract/routines";

/** Longer than a slow page, short enough not to hold up the other fires. */
export const UPTIME_TIMEOUT_MS = 10_000;

export const isWebUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

/** One check: up for any answer under 500, down for a 5xx, a timeout or no answer. */
export interface UptimeProbe {
  ok: boolean;
  detail: string;
  /** No answer at all: this computer's own network may be the one down. */
  unreachable: boolean;
}

export const probeSite = async (
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = UPTIME_TIMEOUT_MS
): Promise<UptimeProbe> => {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The body is never read: the status says it.
    void response.body?.cancel().catch(() => undefined);
    return {
      ok: response.status < 500,
      detail: `HTTP ${response.status}`,
      unreachable: false,
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return {
      ok: false,
      detail:
        name === "TimeoutError" || name === "AbortError"
          ? "timed out"
          : "no answer",
      unreachable: true,
    };
  }
};

/** What a fire does after a check: nothing, or a run told the site went down or came back. */
export type UptimeChange = "down" | "up" | null;

export const nextUptime = (
  was: RoutineUptime | null | undefined,
  probe: Pick<UptimeProbe, "ok" | "detail">,
  now: number
): { uptime: RoutineUptime; change: UptimeChange } => {
  const down = was?.down === true;
  if (probe.ok)
    return {
      uptime: {
        down: false,
        failures: 0,
        since: down || was == null ? now : was.since,
        detail: probe.detail,
      },
      change: down ? "up" : null,
    };
  const failures = (was?.failures ?? 0) + 1;
  const wentDown = !down && failures >= UPTIME_FAILS_BEFORE_DOWN;
  return {
    uptime: {
      down: down || wentDown,
      failures,
      since: wentDown ? now : (was?.since ?? now),
      detail: probe.detail,
    },
    change: wentDown ? "down" : null,
  };
};
