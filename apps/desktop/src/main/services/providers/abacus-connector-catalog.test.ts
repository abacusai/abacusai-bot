/**
 * The post-OAuth confirmation. One immediate read of the (flaky, lagging)
 * listing used to answer "did not complete" over a connect that had in fact
 * completed — the user watched the OAuth succeed and the card call it failed.
 */
import { describe, expect, it } from "vitest";

import type { AbacusConnectorsSnapshot } from "#shared/contracts";

import { confirmConnected } from "./abacus-connector-service";

describe("confirming a connect", () => {
  const listing =
    (answers: Array<Record<string, string> | null>) =>
    async (): Promise<AbacusConnectorsSnapshot> => {
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
