/**
 * A comment under a thumb reaches the team as before, and then the chat's
 * agent, as the user's reply to that message: only a real comment, only in
 * the user's own conversation, whatever became of the team's copy.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("electron", () => {
  const anything: unknown = new Proxy(function () {}, {
    get: (_target, key) => (key === "then" ? undefined : anything),
    apply: () => anything,
    construct: () => anything as object,
  });
  return new Proxy(
    {
      default: anything,
      app: {
        isPackaged: false,
        getPath: () => process.env.ABACUSAI_BOT_HOME,
        getVersion: () => "1.0.86",
        getLocale: () => "en-US",
        getPreferredSystemLanguages: () => ["en-US"],
      },
    },
    {
      get: (target, key) =>
        key in target
          ? (target as Record<PropertyKey, unknown>)[key]
          : key === "then"
            ? undefined
            : anything,
      has: () => true,
    }
  );
});
vi.mock("electron-store", () => ({
  default: class {
    private values: Record<string, unknown>;
    constructor(options: { defaults?: Record<string, unknown> } = {}) {
      this.values = { ...options.defaults };
    }
    get(key: string, fallback?: unknown) {
      return this.values[key] ?? fallback;
    }
    set(key: string, value: unknown) {
      this.values[key] = value;
    }
    delete(key: string) {
      delete this.values[key];
    }
    onDidChange() {
      return () => {};
    }
  },
}));

const { ServiceHost } = await import("./service-host");

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-comment-"));
  vi.stubEnv("ABACUSAI_BOT_HOME", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

const wired = (options: { team: boolean; owner: boolean }) => {
  const host = new ServiceHost();
  const internals = host as unknown as Record<string, any>;
  const order: string[] = [];
  vi.spyOn(internals.feedbackService, "submit").mockImplementation(async () => {
    order.push("team");
    return options.team ? { ok: true } : { ok: false, reason: "failed" };
  });
  const relay = vi
    .spyOn(internals.aguiRelay, "feedback")
    .mockImplementation(async () => {
      order.push("agent");
      return true;
    });
  vi.spyOn(internals, "isOwnerSession").mockReturnValue(options.owner);
  return { host, relay, order };
};

it("sends the team its copy first, then hands the comment to the chat's agent, sent or not", async () => {
  for (const team of [true, false]) {
    const { host, relay, order } = wired({ team, owner: true });
    await expect(
      host.submitTurnFeedback({
        sessionId: "s1",
        segmentId: "a#1",
        rating: "down",
        comment: "  no logo image there  ",
      })
    ).resolves.toEqual(team ? { ok: true } : { ok: false, reason: "failed" });
    expect(order).toEqual(["team", "agent"]);
    expect(relay).toHaveBeenCalledWith({
      threadId: "s1",
      segmentId: "a#1",
      rating: "down",
      comment: "no logo image there",
      note: "no logo image there",
    });
    vi.restoreAllMocks();
  }
});

it("hands a long note to the agent as the pasted-text file it was saved in, keyed by its words", async () => {
  const { host, relay } = wired({ team: true, owner: true });
  const file = "/w/.abacusai-bot/temp/pasted-text-note-1a2b.txt";
  const words = "x".repeat(120_000);
  // Sent four times: Send pressed again, and a retry.
  for (let send = 0; send < 4; send += 1)
    await host.submitTurnFeedback({
      sessionId: "s1",
      segmentId: "a#1",
      rating: "down",
      comment: words,
      commentFile: file,
    });
  // Each goes to the relay with the same file and words: the relay keeps one.
  expect(relay.mock.calls.map(([input]) => input)).toEqual(
    Array.from({ length: 4 }, () => ({
      threadId: "s1",
      segmentId: "a#1",
      rating: "down",
      comment: `@${file}`,
      note: words,
    }))
  );
});

it.each([
  ["a bare thumb", { rating: "up" as const }, true],
  ["a blank comment", { rating: "up" as const, comment: "   " }, true],
  ["a withdrawn thumb", { rating: "clear" as const, comment: "x" }, true],
  [
    "a chat that is not the user's own",
    { rating: "up" as const, comment: "yes" },
    false,
  ],
])("keeps %s with the team", async (_name, input, owner) => {
  const { host, relay, order } = wired({ team: true, owner });
  await host.submitTurnFeedback({ sessionId: "s1", segmentId: "a", ...input });
  expect(order).toEqual(["team"]);
  expect(relay).not.toHaveBeenCalled();
});
