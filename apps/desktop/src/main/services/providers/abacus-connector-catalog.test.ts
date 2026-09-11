/**
 * The availability catalog must never shrink mid-session.
 *
 * `_listValidAgentConnectors` sometimes answers with a fraction of the real
 * catalog — a bot session was offered seven services with no Google anything,
 * while a session moments later saw the full list — and the agent then told
 * the user Google Drive "isn't available". Listings are unioned with what has
 * already been seen this run; the platform stays the authority on what
 * actually attaches when a connect is attempted.
 */
import { describe, expect, it } from "vitest";

import {
  confirmConnected,
  withSeenAvailable,
} from "./abacus-connector-service";

const snapshot = (
  services: string[]
): Parameters<typeof withSeenAvailable>[0] => ({
  ok: true,
  available: services.map((service) => ({ service, name: service })),
  connected: {},
  accounts: {},
});

describe("the connector catalog", () => {
  it("keeps services a flaky listing dropped", () => {
    withSeenAvailable(snapshot(["slack", "googledriveuser", "gmailuser"]));

    const shrunk = withSeenAvailable(snapshot(["slack"]));

    const names = shrunk.available.map((item) => item.service);
    expect(names).toContain("googledriveuser");
    expect(names).toContain("gmailuser");
  });

  it("passes a failed listing through untouched", () => {
    const failed = withSeenAvailable({
      ok: false,
      error: "unavailable",
      available: [],
      connected: {},
      accounts: {},
    });

    expect(failed.available).toEqual([]);
  });
});

/**
 * The post-OAuth confirmation. One immediate read of the (flaky, lagging)
 * listing used to answer "did not complete" over a connect that had in fact
 * completed — the user watched the OAuth succeed and the card call it failed.
 */
describe("confirming a connect", () => {
  const listing =
    (answers: Array<Record<string, string> | null>) =>
    async (): Promise<ReturnType<typeof snapshot>> => {
      const next = answers.shift();
      return next == null
        ? {
            ok: false as const,
            error: "unavailable",
            available: [],
            connected: {},
            accounts: {},
          }
        : { ok: true as const, available: [], connected: next, accounts: {} };
    };

  it("keeps asking while the listing lags, then confirms", async () => {
    const list = listing([{}, {}, { googlecalendar: "conn-1" }]);

    const result = await confirmConnected("googlecalendar", list, 4, 0);

    expect(result).toBe("connected");
  });

  it("answers absent only after real listings said so every time", async () => {
    const list = listing([{}, {}, {}]);

    expect(await confirmConnected("googlecalendar", list, 3, 0)).toBe("absent");
  });

  it("answers unavailable when the platform never answers", async () => {
    const list = listing([null, null, null]);

    expect(await confirmConnected("googlecalendar", list, 3, 0)).toBe(
      "unavailable"
    );
  });

  it("rides a flaky listing to the answer a later attempt gives", async () => {
    const list = listing([null, { googlecalendar: "conn-1" }]);

    expect(await confirmConnected("googlecalendar", list, 2, 0)).toBe(
      "connected"
    );
  });
});
