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

/** Where the server holds each segment once uploaded. */
const uploaded: Record<string, number> = { "text:0:9": 3, "text:0:2": 1 };

const service = (
  fetchImpl: typeof fetch,
  flush = vi.fn(async () => undefined)
) => ({
  flush,
  service: new FeedbackService({
    debugSync: {
      flush,
      sequenceOf: (_sessionId: string, segmentId: string) =>
        uploaded[segmentId] ?? null,
    },
    clientVersion: "1.2.3",
    fetchImpl,
  }),
});

const postedSequence = (fetchImpl: typeof fetch): unknown => {
  const init = vi.mocked(fetchImpl).mock.calls[0]?.[1];
  return JSON.parse(String(init?.body)).event_sequence_number;
};

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
      segmentId: "text:0:9",
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
        segmentId: "text:0:9",
        rating: "up",
      })
    ).toEqual({ ok: false, reason: "that turn has not been synced yet" });
  });

  it("rates an earlier reply under the sequence that reply was uploaded as", async () => {
    const fetchImpl = vi.fn(async () =>
      reply(200, { ok: true })
    ) as unknown as typeof fetch;
    const { service: feedback } = service(fetchImpl);

    expect(
      await feedback.submit({
        sessionId: "sess-1",
        segmentId: "text:0:2",
        rating: "up",
      })
    ).toEqual({ ok: true });
    expect(postedSequence(fetchImpl)).toBe(1);
  });

  it("does not post a rating for a reply the server does not hold", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { service: feedback, flush } = service(fetchImpl);

    expect(
      await feedback.submit({
        sessionId: "sess-1",
        segmentId: "text:0:404",
        rating: "up",
      })
    ).toEqual({ ok: false, reason: "not-synced" });
    expect(flush).toHaveBeenCalledWith("sess-1");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not post without an Abacus.AI key", async () => {
    apiKey = "";
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { service: feedback, flush } = service(fetchImpl);

    expect(
      await feedback.submit({
        sessionId: "sess-1",
        segmentId: "text:0:9",
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
        segmentId: "text:0:2",
        rating: "down",
        comment: "  too slow  ",
        model: "abacus/x",
      })
    ).toEqual({
      sessionId: "sess-1",
      segmentId: "text:0:2",
      rating: "down",
      comment: "too slow",
      model: "abacus/x",
    });
    expect(
      sanitizeFeedback({
        sessionId: "s",
        segmentId: "t",
        rating: "up",
        comment: "x".repeat(5000),
      })?.comment
    ).toHaveLength(2000);
  });

  it.each([
    ["no object", "up"],
    [
      "a session id with a path in it",
      { sessionId: "../etc", segmentId: "t", rating: "up" },
    ],
    ["no segment", { sessionId: "s", rating: "up" }],
    ["an empty segment id", { sessionId: "s", segmentId: "", rating: "up" }],
    ["a numeric segment id", { sessionId: "s", segmentId: 1, rating: "up" }],
    ["an unknown rating", { sessionId: "s", segmentId: "t", rating: "meh" }],
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

describe("where the rating is posted", () => {
  it("ignores the URL override in a packaged build: the post carries the key", async () => {
    apiKey = "abacus-key";
    process.env.ABACUSAI_BOT_FEEDBACK_URL = "https://collector.example/steal";
    const fetchImpl = vi.fn(async () => reply(200, { success: true }));
    await service(fetchImpl as unknown as typeof fetch).service.submit({
      sessionId: "s1",
      segmentId: "text:0:9",
      rating: "up",
    });
    delete process.env.ABACUSAI_BOT_FEEDBACK_URL;

    const url = String(
      (fetchImpl.mock.calls as unknown as unknown[][])[0]?.[0] ?? ""
    );
    expect(url).not.toContain("collector.example");
    expect(url).toContain("abacusaibot_feedback");
  });
});
