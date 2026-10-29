/**
 * The shared bots' link state, asked of the server one question at a time.
 *
 * Status, pair, the consent link and unlink each read or change the same
 * server-side link, and each reply is applied to the lane as it lands. Sent
 * side by side, they raced:
 *
 * - A status read the server answered just before a consent link landed came
 *   back after the link, and put the just-linked lane back to "not linked".
 * - On a brand-new account, the lane's first status and the connect dialog's
 *   pair both asked the server to set up the account's desktop link, and the
 *   one that lost was refused ("still being set up"): the pairing card showed
 *   an error on the user's first try.
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
  pair: () => Promise<{ status: string }>;
  linkUrl: (target: "authorize") => string;
  completeAuthorize: (callbackUrl: string) => Promise<void>;
  sharedLink: () => { status: string };
};

const REDIRECT = "https://example.test/oauth/callback";

const respond = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The server: one account whose desktop link does not exist yet, set up by
 * whichever call reaches it first. A second call that arrives while that set-up
 * is under way is refused, as the server does. Status reads are slow and read
 * the link as it stood when they arrived.
 */
const server = {
  linked: false,
  setUp: false,
  settingUp: false,
  inFlight: 0,
  maxInFlight: 0,
};

const ensureDesktopLink = async (): Promise<Response | null> => {
  if (server.setUp) return null;
  if (server.settingUp)
    return respond(400, {
      error:
        "Your desktop link is still being set up. Please try again in a moment.",
    });
  server.settingUp = true;
  await wait(40);
  server.setUp = true;
  server.settingUp = false;
  return null;
};

globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
  if (body.action === "inbox") return new Promise<Response>(() => {});
  server.inFlight += 1;
  server.maxInFlight = Math.max(server.maxInFlight, server.inFlight);
  try {
    const refused = await ensureDesktopLink();
    if (refused != null) return refused;
    switch (body.action) {
      case "status": {
        const linked = server.linked;
        await wait(200);
        return respond(200, {
          available: ["discord"],
          channels: { discord: { status: linked ? "linked" : "unlinked" } },
        });
      }
      case "pair":
        return respond(200, {
          status: "pending",
          code: "1234",
          deep_link: "https://discord.com/oauth2/authorize?client_id=42",
          expires_at: Date.now() / 1000 + 600,
          oauth_client_id: "42",
          oauth_authorize_url: "https://discord.com/oauth2/authorize",
          oauth_scopes: ["identify"],
          oauth_extras: [],
          oauth_redirect_uri: REDIRECT,
        });
      case "link_oauth":
        await wait(10);
        server.linked = true;
        return respond(200, { status: "linked", display_name: "someone" });
      default:
        return respond(200, {});
    }
  } finally {
    server.inFlight -= 1;
  }
}) as unknown as typeof fetch;

const started: Connector[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const connector of started.splice(0)) await connector.stop();
  Object.assign(server, {
    linked: false,
    setUp: false,
    settingUp: false,
    inFlight: 0,
    maxInFlight: 0,
  });
});

const lane = (states: string[]): Connector => {
  const connector = new AbacusChannelsConnector(
    {
      onMessage: () => {},
      onState: (state) => states.push(state),
      onLog: () => {},
    },
    "discord"
  ) as unknown as Connector;
  started.push(connector);
  return connector;
};

describe("a shared bot lane's link state", () => {
  it("pairs on a new account while the lane's first status is still out", async () => {
    vi.useFakeTimers();
    const connector = lane([]);

    // The connect dialog turns the lane on and asks for a code at once.
    const starting = connector.start();
    const paired = connector.pair();
    const outcome = paired.then(
      (link) => link.status,
      (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await starting;

    expect(await outcome).toBe("pending");
    expect(server.maxInFlight).toBe(1);
  });

  it("stays linked when a status read sent before the consent link lands after it", async () => {
    vi.useFakeTimers();
    const states: string[] = [];
    const connector = lane(states);
    const starting = connector.start();
    await vi.advanceTimersByTimeAsync(300);
    await starting;
    const paired = connector.pair();
    await vi.advanceTimersByTimeAsync(100);
    await paired;
    const state = new URL(connector.linkUrl("authorize")).searchParams.get(
      "state"
    );

    // The pairing watch's status read goes out, then the consent page answers.
    await vi.advanceTimersByTimeAsync(3_050);
    const linking = connector.completeAuthorize(
      `${REDIRECT}?state=${state}&code=grant`
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await linking;

    expect(connector.sharedLink().status).toBe("linked");
    expect(states.at(-1)).toBe("connected");
  });
});
