/**
 * A pairing code that runs out while the user is still finding their phone.
 *
 * The QR was minted with a server-set lifetime, and past it the pane said
 * "that code expired, link again", asking the user to redo by hand what the
 * app can do for them, and leaving whoever was mid-scan pointed at a QR that
 * silently does nothing. It mints a fresh one instead.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  shell: { openExternal: vi.fn() },
}));
vi.mock("../../bring-to-front", () => ({ parentWindow: () => undefined }));
vi.mock("../providers/abacus", () => ({ resolveAbacusApiKey: () => "key" }));
vi.mock("../providers/abacus-host", () => ({
  abacusRoutellmV1: () => "https://example.test/v1",
  abacusUserAgent: () => "test",
}));
vi.mock("./discord-web-connector", () => ({
  DISCORD_PARTITION: "persist:discord-web",
}));
vi.mock("qrcode", () => ({
  default: { toDataURL: async () => "data:image/png;base64,QR" },
}));

const { AbacusChannelsConnector } = await import("./abacus-channels-connector");

type Connector = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  pair: () => Promise<{ status: string; qrDataUrl?: string }>;
  link: { status: string; expiresAt?: number; qrDataUrl?: string };
};

/** Codes in the order the server hands them out, each already stale. */
const codes: string[] = [];
const pairs: number[] = [];

/** How far the server's clock is behind this computer's; null: no clock sent. */
let serverBehindMs: number | null = null;

const respond = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(serverBehindMs != null
        ? { date: new Date(Date.now() - serverBehindMs).toUTCString() }
        : {}),
    },
  });

globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as {
    action?: string;
  };

  if (body.action === "pair") {
    pairs.push(Date.now());
    const code = `code-${pairs.length}`;
    codes.push(code);
    return respond({
      status: "pending",
      qr_data: `https://t.me/bot?start=${code}`,
      deep_link: `https://t.me/bot?start=${code}`,
      // Already past: the next tick has to decide what to do about it. With
      // a server clock, ten minutes ahead of it, as the server mints them.
      expires_at:
        serverBehindMs != null
          ? (Date.now() - serverBehindMs) / 1000 + 600
          : Date.now() / 1000 - 1,
    });
  }

  return respond({ available: ["telegram"], channels: {} });
}) as unknown as typeof fetch;

const started: Connector[] = [];

afterEach(async () => {
  for (const connector of started.splice(0)) await connector.stop();
  codes.length = 0;
  pairs.length = 0;
  serverBehindMs = null;
});

const telegram = async (logs: string[]): Promise<Connector> => {
  const connector = new AbacusChannelsConnector(
    {
      onMessage: () => {},
      onState: () => {},
      onLog: (line) => logs.push(line),
    },
    "telegram"
  ) as unknown as Connector;
  await connector.start();
  started.push(connector);
  return connector;
};

describe("a pairing code that has run out", () => {
  it("is replaced with a fresh one, and the pane stays on the QR", async () => {
    vi.useFakeTimers();
    try {
      const logs: string[] = [];
      const connector = await telegram(logs);

      await connector.pair();
      expect(connector.link.status).toBe("pending");
      expect(pairs).toHaveLength(1);

      // The watch wakes, finds the code stale, and asks for another.
      await vi.advanceTimersByTimeAsync(3_500);

      expect(pairs.length).toBeGreaterThan(1);
      // Not "link again for a new one": there is a QR on screen to scan.
      expect(connector.link.status).toBe("pending");
      expect(connector.link.qrDataUrl).toBeTruthy();
      expect(logs.join("\n")).toContain("showing a fresh one");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a fresh pairing code on a computer whose clock is off", () => {
  it.each([
    ["5 hours ahead", 5 * 60 * 60_000],
    ["13 hours ahead", 13 * 60 * 60_000],
    ["right", 0],
  ])("is kept on screen when the clock is %s", async (_label, behindMs) => {
    vi.useFakeTimers();
    try {
      serverBehindMs = behindMs;
      const connector = await telegram([]);

      await connector.pair();
      // A minute of the card's polls: well inside the code's ten minutes.
      await vi.advanceTimersByTimeAsync(60_000);

      expect(pairs).toHaveLength(1);
      expect(connector.link.status).toBe("pending");
    } finally {
      vi.useRealTimers();
    }
  });
});
