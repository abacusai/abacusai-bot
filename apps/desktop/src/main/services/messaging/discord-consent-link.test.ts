/**
 * Linking the Discord bot by one click on Discord's own consent page, in the
 * app's one Discord window.
 *
 * The code flow asked for an install in a second window, a copied command,
 * the bot's hidden chat and a paste, and most users who signed in stopped
 * somewhere in it. The second window also shared the first one's sign-in:
 * linking the bot there signed the app's own Discord out seconds later. The
 * consent page's answer is caught in the Discord window and linked by the
 * server; the code steps stay as the fallback.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type Listener = (event: { preventDefault: () => void }, url: string) => void;

vi.mock("electron", () => ({
  BrowserWindow: class {
    constructor() {
      throw new Error("no second Discord window");
    }
  },
  session: { fromPartition: () => ({}) },
  shell: { openExternal: vi.fn() },
}));
vi.mock("../../bring-to-front", () => ({
  parentWindow: () => undefined,
  bringToFront: () => {},
  dismissOnEscape: () => {},
  presentAsDialog: (win: { show: () => void }) => win.show(),
}));
vi.mock("../providers/abacus", () => ({ resolveAbacusApiKey: () => "key" }));
vi.mock("../providers/abacus-host", () => ({
  abacusRoutellmV1: () => "https://example.test/v1",
  abacusUserAgent: () => "test",
}));

const { AbacusChannelsConnector } = await import("./abacus-channels-connector");
const { DiscordWebConnector } = await import("./discord-web-connector");
const { MessagingGatewayService } = await import("./messaging-gateway-service");

const REDIRECT = "https://example.test/oauth/callback";
const CONSENT = {
  oauth_client_id: "42",
  oauth_authorize_url: "https://discord.com/oauth2/authorize",
  oauth_scopes: ["identify", "applications.commands"],
  oauth_extras: ["response_type=code", "integration_type=1"],
  oauth_redirect_uri: REDIRECT,
};

/** What the server was asked, and how it answers `link_oauth`. */
const server = {
  calls: [] as Array<Record<string, unknown>>,
  pair: {} as Record<string, unknown>,
  link: { status: 200, body: {} as Record<string, unknown> },
};

const respond = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<
    string,
    unknown
  >;
  server.calls.push(body);
  if (body.action === "pair")
    return respond(200, {
      status: "pending",
      code: "abc",
      deep_link: "https://discord.com/oauth2/authorize?client_id=42",
      ...server.pair,
    });
  if (body.action === "link_oauth")
    return respond(server.link.status, server.link.body);
  return respond(200, { available: ["discord"], channels: {} });
}) as unknown as typeof fetch;

afterEach(() => {
  server.calls.length = 0;
  server.pair = {};
  server.link = { status: 200, body: {} };
});

const callbacks = () => ({
  onMessage: () => {},
  onState: vi.fn(),
  onLog: () => {},
  onSelfLinked: vi.fn(),
});

const pending = async (
  platform: "electron" | "web-host" = "electron",
  pair: Record<string, unknown> = CONSENT
) => {
  server.pair = pair;
  const hooks = callbacks();
  const connector = new AbacusChannelsConnector(hooks, "discord", platform);
  await connector.pair();
  return { connector, hooks };
};

const stateOf = (url: string): string =>
  new URL(url).searchParams.get("state") ?? "";

describe("the consent page", () => {
  it("is offered with every parameter the server sent, under a fresh state", async () => {
    const { connector } = await pending();
    expect(connector.sharedLink()).toMatchObject({
      status: "pending",
      oneClick: true,
      code: "abc",
    });
    const url = new URL(connector.linkUrl("authorize"));
    expect(url.origin + url.pathname).toBe(CONSENT.oauth_authorize_url);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "42",
      redirect_uri: REDIRECT,
      scope: "identify applications.commands",
      response_type: "code",
      integration_type: "1",
    });
    expect(stateOf(url.href)).toMatch(/^[0-9a-f]{32}$/);
    expect(stateOf(connector.linkUrl("authorize"))).not.toBe(stateOf(url.href));
    expect(connector.consentRedirectUri()).toBe(REDIRECT);
  });

  it("is not offered by a server without it, nor on a browser host", async () => {
    for (const [platform, pair] of [
      ["electron", { oauth_client_id: null }],
      ["web-host", CONSENT],
    ] as const) {
      const { connector } = await pending(platform, pair);
      expect(connector.sharedLink().oneClick).toBe(false);
      expect(() => connector.linkUrl("authorize")).toThrow();
      expect(connector.linkUrl("install")).toContain("client_id=42");
    }
  });
});

describe("the consent page's answer", () => {
  it("links the account the grant names, and keeps the way to its chat", async () => {
    const { connector, hooks } = await pending();
    server.link.body = { status: "linked", display_name: "Sam" };
    const state = stateOf(connector.linkUrl("authorize"));
    await connector.completeAuthorize(`${REDIRECT}?code=grant&state=${state}`);
    expect(server.calls.at(-1)).toEqual({
      action: "link_oauth",
      channel: "discord",
      code: "grant",
    });
    expect(connector.sharedLink()).toEqual({
      status: "linked",
      displayName: "Sam",
      botProfileUrl: "https://discord.com/users/42",
    });
    expect(hooks.onSelfLinked).toHaveBeenCalledTimes(1);
  });

  it("is dropped for another state, and changes nothing when declined", async () => {
    const { connector } = await pending();
    const state = stateOf(connector.linkUrl("authorize"));
    await connector.completeAuthorize(`${REDIRECT}?code=grant&state=other`);
    // A state is good for one answer only.
    await connector.completeAuthorize(`${REDIRECT}?code=grant&state=${state}`);
    const declined = stateOf(connector.linkUrl("authorize"));
    await connector.completeAuthorize(
      `${REDIRECT}?error=access_denied&state=${declined}`
    );
    expect(server.calls.some((c) => c.action === "link_oauth")).toBe(false);
    expect(connector.sharedLink()).toMatchObject({
      status: "pending",
      oneClick: true,
    });
    expect(connector.sharedLink().error).toBeUndefined();
  });

  it("leaves the card pending with the server's reason when the link fails", async () => {
    const { connector } = await pending();
    server.link = {
      status: 400,
      body: { error: "Discord did not accept the sign-in. Please try again." },
    };
    const state = stateOf(connector.linkUrl("authorize"));
    await connector.completeAuthorize(`${REDIRECT}?code=grant&state=${state}`);
    expect(connector.sharedLink()).toMatchObject({
      status: "pending",
      code: "abc",
      error: "Discord did not accept the sign-in. Please try again.",
    });
  });
});

/** A stand-in for the Discord window: listeners, loads and visibility. */
const fakeWindow = () => {
  const nav = new Map<string, Listener>();
  const events = new Map<string, () => void>();
  const win = {
    loaded: [] as string[],
    visible: false,
    webContents: {
      on: (name: string, fn: Listener) => nav.set(name, fn),
      off: (name: string) => nav.delete(name),
    },
    on: (name: string, fn: () => void) => events.set(name, fn),
    off: (name: string) => events.delete(name),
    loadURL: async (url: string) => {
      win.loaded.push(url);
    },
    show: () => {
      win.visible = true;
    },
    hide: () => {
      win.visible = false;
      events.get("hide")?.();
    },
    isVisible: () => win.visible,
    isDestroyed: () => false,
  };
  const navigate = (name: string, url: string): boolean => {
    let refused = false;
    nav.get(name)?.({ preventDefault: () => (refused = true) }, url);
    return refused;
  };
  return { win, nav, navigate };
};

const discordWith = (win: unknown) => {
  const discord = new DiscordWebConnector({
    onMessage: () => {},
    onState: () => {},
    onLog: () => {},
  } as never);
  Object.assign(discord as unknown as Record<string, unknown>, {
    running: true,
    window: win,
  });
  return discord;
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a link page in the Discord window", () => {
  it("is caught at the redirect, never loaded, and the window goes home", async () => {
    const { win, nav, navigate } = fakeWindow();
    const answer = discordWith(win).present(
      "https://discord.com/oauth2/authorize?state=s",
      REDIRECT
    );
    await settle();
    expect(win.visible).toBe(true);
    expect(navigate("will-navigate", "discord://-/oauth2")).toBe(true);
    expect(navigate("will-navigate", "https://discord.com/login")).toBe(false);
    expect(navigate("will-redirect", `${REDIRECT}?code=g&state=s`)).toBe(true);
    await expect(answer).resolves.toBe(`${REDIRECT}?code=g&state=s`);
    expect(win.visible).toBe(false);
    expect(win.loaded).toEqual([
      "https://discord.com/oauth2/authorize?state=s",
      "https://discord.com/channels/@me",
    ]);
    expect(nav.size).toBe(0);
  });

  it("answers null when the user puts it away or the link lands", async () => {
    const first = fakeWindow();
    const away = discordWith(first.win).present("https://discord.com/users/42");
    await settle();
    first.win.hide();
    await expect(away).resolves.toBeNull();

    const second = fakeWindow();
    const discord = discordWith(second.win);
    const landed = discord.present("https://discord.com/users/42");
    await settle();
    discord.endPresentation();
    await expect(landed).resolves.toBeNull();
    expect(second.win.loaded.at(-1)).toBe("https://discord.com/channels/@me");
  });
});

describe("a link page while the window is busy", () => {
  it("answers before the window has gone home, which then holds the queue", async () => {
    const { win, navigate } = fakeWindow();
    let home: () => void = () => {};
    const load = win.loadURL;
    win.loadURL = (url: string) =>
      url.endsWith("/channels/@me")
        ? new Promise<void>((resolve) => {
            win.loaded.push(url);
            home = resolve;
          })
        : load(url);
    const discord = discordWith(win);
    const answer = discord.present("https://discord.com/oauth2/x", REDIRECT);
    await settle();
    navigate("will-redirect", `${REDIRECT}?code=g&state=s`);
    await expect(answer).resolves.toContain("code=g");
    expect(win.loaded.at(-1)).toBe("https://discord.com/channels/@me");
    const next = vi.fn();
    const inner = discord as unknown as {
      serialize: (task: () => Promise<void>) => Promise<void>;
    };
    const queued = inner.serialize(async () => next());
    await settle();
    expect(next).not.toHaveBeenCalled();
    home();
    await queued;
    expect(next).toHaveBeenCalled();
  });
});

describe("the Discord card in the gateway", () => {
  const gatewayWith = (discord: unknown, shared: unknown) => {
    const emitChanged = vi.fn();
    const gateway = new MessagingGatewayService({
      resolveWorkspaceId: () => null,
      emitChanged,
    } as never);
    const connectors = (
      gateway as unknown as { connectors: Map<string, unknown> }
    ).connectors;
    if (discord != null) connectors.set("discord", discord);
    connectors.set("abacus_discord", shared);
    return { gateway, emitChanged };
  };

  it("opens the consent page in the Discord window and links its answer", async () => {
    const { connector } = await pending();
    server.link.body = { status: "linked", display_name: "Sam" };
    const discord = discordWith(fakeWindow().win);
    const present = vi
      .spyOn(discord, "present")
      .mockImplementation(
        async (url) => `${REDIRECT}?code=grant&state=${stateOf(url)}`
      );
    const { gateway, emitChanged } = gatewayWith(discord, connector);

    await gateway.openSharedChannelLink("abacus_discord", "authorize");
    await vi.waitFor(() => expect(emitChanged).toHaveBeenCalled());
    expect(present).toHaveBeenCalledWith(
      expect.stringContaining("client_id=42"),
      REDIRECT
    );
    expect(connector.sharedLink().status).toBe("linked");
  });

  it("offers one click only where the Discord window is there to catch it", async () => {
    const { connector } = await pending();
    const sharedLink = (gateway: unknown) =>
      (
        gateway as { sharedLink: (id: string) => { oneClick?: boolean } }
      ).sharedLink("abacus_discord");
    const withWindow = gatewayWith(discordWith(fakeWindow().win), connector);
    expect(sharedLink(withWindow.gateway).oneClick).toBe(true);
    const without = gatewayWith(null, connector);
    expect(sharedLink(without.gateway).oneClick).toBe(false);
  });
});
