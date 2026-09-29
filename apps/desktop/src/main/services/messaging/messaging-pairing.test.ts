/**
 * The pending list has to stay usable on a platform anyone can reach.
 *
 * Re-recording one sender is already a no-op, so no single stranger can grow
 * the file. Distinct senders were unbounded, and email makes that a certainty
 * rather than an attack, since every spam message arrives from a new address.
 * Each one added a row, rewrote messaging.json and refreshed the pane, so the
 * list a real request has to be found in fills with junk and every inbound
 * message pays to rewrite it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pairing-"));

vi.mock("../../paths", () => ({ abacusBotHome: () => home }));

const store = await import("./messaging-config-service");

const reset = (): void => {
  fs.rmSync(path.join(home, "messaging.json"), { force: true });
};

beforeEach(reset);
afterEach(reset);

/** One stranger's first message, as the gateway records it. */
const request = (userId: string): void => {
  store.recordPairingRequest({
    platform: "discord",
    userId,
    userName: userId,
    chatId: userId,
    firstMessage: "buy cheap watches",
  });
};

const pending = (): string[] =>
  store
    .listPairing()
    .filter((row) => row.status === "pending")
    .map((row) => row.userId);

describe("a flood of strangers", () => {
  it("does not grow the pending list without limit", () => {
    for (let i = 0; i < 200; i += 1)
      request(`spam-${String(i).padStart(3, "0")}@example.test`);

    // The regression: 200 rows, every one of them rewritten into
    // messaging.json by the message after it.
    expect(pending().length).toBe(50);
  });

  it("keeps the most recent requests, which are the ones worth deciding on", () => {
    for (let i = 0; i < 60; i += 1)
      request(`sender-${String(i).padStart(3, "0")}@example.test`);

    const kept = pending();
    expect(kept).toContain("sender-059@example.test");
    expect(kept).not.toContain("sender-000@example.test");
  });

  it("never evicts an approved sender", () => {
    request("real-person@example.test");
    store.approvePairing("discord", "real-person@example.test");

    for (let i = 0; i < 200; i += 1)
      request(`spam-${String(i).padStart(3, "0")}@example.test`);

    const approved = store.approvedUserIds("discord");
    expect(approved.has("real-person@example.test")).toBe(true);
  });

  it("still records normally below the cap", () => {
    request("a@example.test");
    request("b@example.test");

    expect(pending()).toEqual(["a@example.test", "b@example.test"]);
  });

  it("leaves one sender messaging repeatedly as a single row", () => {
    for (let i = 0; i < 30; i += 1) request("chatty@example.test");

    expect(pending()).toEqual(["chatty@example.test"]);
  });
});
