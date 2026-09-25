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

const respond = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
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
      // Already past: the next tick has to decide what to do about it.
      expires_at: Date.now() / 1000 - 1,
    });
  }

  return respond({ available: ["telegram"], channels: {} });
}) as unknown as typeof fetch;

const started: Connector[] = [];

afterEach(async () => {
  for (const connector of started.splice(0)) await connector.stop();
  codes.length = 0;
  pairs.length = 0;
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
