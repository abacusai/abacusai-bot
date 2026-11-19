/**
 * A pairing code withdrawn because the connect that minted it was abandoned
 * (AbacusChannelsConnector.endPairing). The app window showing the code
 * closes with it, and nothing keeps polling. A Start tapped just before is
 * kept, not withdrawn.
 */
import { afterEach, expect, it, vi } from "vitest";

const window = vi.hoisted(() => ({
  loadURL: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  close: vi.fn(),
  isDestroyed: () => false,
  on: vi.fn(),
  webContents: {
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setAudioMuted: vi.fn(),
  },
}));
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => "/tmp" },
  session: {
    fromPartition: () => ({ webRequest: { onBeforeRequest: () => {} } }),
  },
  BrowserWindow: class {
    constructor() {
      return window;
    }
  },
}));
vi.mock("../../bring-to-front", () => ({ parentWindow: () => null }));
vi.mock("../providers/abacus", () => ({ resolveAbacusApiKey: () => "key" }));
vi.mock("../providers/abacus-host", () => ({
  abacusRoutellmV1: () => "https://example.test/v1",
  abacusUserAgent: () => "test",
}));
vi.mock("qrcode", () => ({
  default: { toDataURL: async () => "data:image/png;base64,QR" },
}));

const { AbacusChannelsConnector } = await import("./abacus-channels-connector");

/** Whether the server reads the link as made; every call, by action. */
let linkedOnServer = false;
const calls: string[] = [];

globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as { action: string };
  calls.push(body.action);
  if (body.action === "inbox")
    return new Promise<Response>(() => {
      // Long poll: holds while the test runs.
    });
  const answer =
    body.action === "pair"
      ? {
          status: "pending",
          deep_link: "https://t.me/bot?start=code-1",
          expires_at: Date.now() / 1000 + 600,
        }
      : {
          available: ["telegram"],
          channels: linkedOnServer
            ? { telegram: { status: "linked", display_name: "Me" } }
            : {},
        };
  return new Response(JSON.stringify(answer), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as unknown as typeof fetch;

const started: InstanceType<typeof AbacusChannelsConnector>[] = [];

afterEach(async () => {
  for (const connector of started.splice(0)) await connector.stop();
  vi.useRealTimers();
  linkedOnServer = false;
  calls.length = 0;
  window.close.mockClear();
});

/** A running Telegram shared lane, not linked, its code shown in the app's window. */
const pairing = async () => {
  vi.useFakeTimers();
  const states: string[] = [];
  const connector = new AbacusChannelsConnector(
    {
      onState: (state: string) => states.push(state),
      onLog: () => {},
      onMessage: () => {},
    } as never,
    "telegram",
    "electron"
  );
  started.push(connector);
  await connector.start();
  await connector.pair();
  connector.openLink("install");
  expect(window.loadURL).toHaveBeenCalledWith("https://t.me/bot?start=code-1");
  return { connector, states };
};

it("closes the window showing the code, reads not linked, and stops polling", async () => {
  const { connector, states } = await pairing();
  calls.length = 0;
  const link = await connector.endPairing();
  expect(window.close).toHaveBeenCalledTimes(1);
  expect(link.status).toBe("unlinked");
  expect(states.at(-1)).toBe("needs_login");
  // One read of the link before withdrawing, then nothing.
  expect(calls).toEqual(["status"]);
  calls.length = 0;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(calls).toEqual([]);
});

it("keeps a Start that landed since the last poll", async () => {
  const { connector, states } = await pairing();
  linkedOnServer = true;
  const link = await connector.endPairing();
  expect(link.status).toBe("linked");
  expect(states.at(-1)).toBe("connected");
  // Linked: the window closes as a landed link closes it.
  expect(window.close).toHaveBeenCalledTimes(1);
});
