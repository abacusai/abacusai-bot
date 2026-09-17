import { beforeEach, describe, expect, it, vi } from "vitest";

let apiKey = "abacus-key";

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "1.0.0", userAgentFallback: "" },
}));
vi.mock("../config/settings", () => ({
  readSettings: () => ({ apiKeys: { ABACUS_API_KEY: apiKey } }),
}));
vi.mock("../diagnostics/client-environment", () => ({
  clientEnvironment: () => ({ os_name: "macOS" }),
}));

const { FeedbackService, sanitizeFeedback } =
  await import("./feedback-service");

const service = (
  fetchImpl: typeof fetch,
  flush = vi.fn(async () => undefined)
) => ({
  flush,
  service: new FeedbackService({
    debugSync: { flush } as never,
    clientVersion: "1.2.3",
    fetchImpl,
  }),
});

const reply = (status: number, body: unknown = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("reporting a turn's thumbs", () => {
  beforeEach(() => {
    apiKey = "abacus-key";
  });

  it("flushes the transcript first, then posts the verdict with the key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const order: string[] = [];
    const flush = vi.fn(async () => {
      order.push("flush");
    });
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      order.push("post");
      calls.push({ url, init });
      return reply(200, { ok: true, reported: true });
    }) as unknown as typeof fetch;
    const { service: feedback } = service(fetchImpl, flush);

    const outcome = await feedback.submit({
      sessionId: "sess-1",
      eventSequenceNumber: 3,
      rating: "down",
      model: "abacus/stealth/union-alpha",
    });

    expect(outcome).toEqual({ ok: true });
    expect(flush).toHaveBeenCalledWith("sess-1");
    expect(order).toEqual(["flush", "post"]);
    const call = calls[0];
    if (call == null) throw new Error("no request was made");
    expect(call.url).toMatch(/\/abacusaibot_feedback$/);
    expect((call.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer abacus-key"
    );
    expect(JSON.parse(call.init.body as string)).toEqual({
      session_id: "sess-1",
      event_sequence_number: 3,
      rating: "down",
      comment: "",
      model: "abacus/stealth/union-alpha",
      platform: "macOS",
      client_version: "1.2.3",
    });
  });

  it("returns the platform's reason when it refuses", async () => {
    const fetchImpl = vi.fn(async () =>
      reply(404, { error: "that turn has not been synced yet" })
    ) as unknown as typeof fetch;
    const { service: feedback } = service(fetchImpl);

    expect(
      await feedback.submit({
        sessionId: "sess-1",
        eventSequenceNumber: 3,
        rating: "up",
      })
    ).toEqual({ ok: false, reason: "that turn has not been synced yet" });
  });

  it("does not post without an Abacus.AI key", async () => {
    apiKey = "";
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { service: feedback, flush } = service(fetchImpl);

    expect(
      await feedback.submit({
        sessionId: "sess-1",
        eventSequenceNumber: 0,
        rating: "up",
      })
    ).toEqual({ ok: false, reason: "no-key" });
    expect(flush).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("what the renderer may send", () => {
  it("passes a well-formed rating through, trimmed and capped", () => {
    expect(
      sanitizeFeedback({
        sessionId: "sess-1",
        eventSequenceNumber: 2,
        rating: "down",
        comment: "  too slow  ",
        model: "abacus/x",
      })
    ).toEqual({
      sessionId: "sess-1",
      eventSequenceNumber: 2,
      rating: "down",
      comment: "too slow",
      model: "abacus/x",
    });
    expect(
      sanitizeFeedback({
        sessionId: "s",
        eventSequenceNumber: 0,
        rating: "up",
        comment: "x".repeat(5000),
      })?.comment
    ).toHaveLength(2000);
  });

  it.each([
    ["no object", "up"],
    [
      "a session id with a path in it",
      { sessionId: "../etc", eventSequenceNumber: 0, rating: "up" },
    ],
    [
      "a negative index",
      { sessionId: "s", eventSequenceNumber: -1, rating: "up" },
    ],
    [
      "a fractional index",
      { sessionId: "s", eventSequenceNumber: 1.5, rating: "up" },
    ],
    [
      "a string index",
      { sessionId: "s", eventSequenceNumber: "1", rating: "up" },
    ],
    [
      "an unknown rating",
      { sessionId: "s", eventSequenceNumber: 1, rating: "meh" },
    ],
  ])("refuses %s", (_label, input) => {
    expect(sanitizeFeedback(input)).toBeNull();
  });

  it("never posts a refused input", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { service: feedback, flush } = service(fetchImpl);

    expect(await feedback.submit({ rating: "up" })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(flush).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
