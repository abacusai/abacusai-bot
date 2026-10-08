import { describe, expect, it } from "vitest";

import { CONNECT_OFFER_LIFETIME_MS, PendingWaits } from "./pending-waits";

describe("PendingWaits: connector offers", () => {
  it("lists a session's unconnected offers by connector, never another session's", () => {
    let now = 1_000;
    const waits = new PendingWaits(() => now);
    waits.connectOffered("phone", [{ id: "gmail", label: "Gmail" }]);
    now = 2_000;
    waits.connectOffered("other", [{ id: "slack", label: "Slack" }]);
    expect(waits.list("phone", new Set())).toEqual([
      {
        itemId: "connect:gmail",
        kind: "connector",
        stage: "link_sent",
        site: null,
        label: "Gmail",
        since: 1_000,
        expiresAt: 1_000 + CONNECT_OFFER_LIFETIME_MS,
      },
    ]);
  });

  it("drops what connected, through the watcher or seen in the statuses", () => {
    const waits = new PendingWaits(() => 0);
    waits.connectOffered("phone", [
      { id: "gmail", label: "Gmail" },
      { id: "google-calendar", label: "Google Calendar" },
      { id: "slack", label: "Slack" },
    ]);
    waits.connectLanded(["gmail"]);
    expect(
      waits.list("phone", new Set(["slack"])).map((wait) => wait.itemId)
    ).toEqual(["connect:google-calendar"]);
  });

  it("restarts an offer's clock when it is sent again, and lets it go once its life is over", () => {
    let now = 0;
    const waits = new PendingWaits(() => now);
    waits.connectOffered("phone", [{ id: "gmail", label: "Gmail" }]);
    now = 10_000;
    waits.connectOffered("phone", [{ id: "gmail", label: "Gmail" }]);
    expect(waits.list("phone", new Set())[0]!.since).toBe(10_000);
    now = 10_000 + CONNECT_OFFER_LIFETIME_MS;
    expect(waits.list("phone", new Set())).toEqual([]);
  });

  it("ignores an offer with no session", () => {
    const waits = new PendingWaits();
    waits.connectOffered(null, [{ id: "gmail", label: "Gmail" }]);
    expect(waits.list("", new Set())).toEqual([]);
  });
});
