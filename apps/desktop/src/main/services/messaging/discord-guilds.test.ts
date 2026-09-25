/**
 * Discord's server reach: servers and their channels resolve as contacts,
 * server chat ids are accepted, and server inbound is the mention pill,
 * which is reported once per change, not once per sweep.
 *
 * Also pinned: every navigation carries the plain-Chrome user agent.
 * discord.com can wedge its boot under the default Electron UA.
 */
import fs from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

import { DiscordWebConnector, sendProbe } from "./discord-web-connector";

type Inbound = { chatId: string; userName: string | null; text: string };

const connector = (): {
  c: DiscordWebConnector;
  messages: Inbound[];
} => {
  const messages: Inbound[] = [];
  const c = new DiscordWebConnector({
    onMessage: (message) => messages.push(message as Inbound),
    onState: () => {},
    onLog: () => {},
  });
  return { c, messages };
};

// The privates under test, without booting Electron for them.
type Internals = {
  contacts: Array<{ chatId: string; name: string }>;
  guilds: Array<{ guildId: string; name: string; mentions: number }>;
  guildChannels: Map<string, Array<{ chatId: string; name: string }>>;
  firstInboundSweep: boolean;
  run: (script: string, args: Record<string, unknown>) => Promise<unknown>;
  sweepGuildMentions: () => Promise<void>;
};

const internals = (c: DiscordWebConnector): Internals =>
  c as unknown as Internals;

describe("server contacts", () => {
  it("lists DMs, then servers, then crawled channels", () => {
    const { c } = connector();
    const inner = internals(c);
    inner.contacts = [{ chatId: "111", name: "Sd" }];
    inner.guilds = [{ guildId: "22", name: "SolidJS", mentions: 0 }];
    inner.guildChannels.set("22", [
      { chatId: "22/33", name: "#general (SolidJS)" },
    ]);

    expect(c.listContacts()).toEqual([
      { chatId: "111", name: "Sd" },
      { chatId: "22", name: "SolidJS (server)" },
      { chatId: "22/33", name: "#general (SolidJS)" },
    ]);
  });
});

describe("server chat ids", () => {
  it("rejects a name outright instead of driving the page", async () => {
    const { c } = connector();
    // No window exists in this test; reaching for one would throw, so an
    // empty answer here proves the id was refused before any page driving.
    await expect(c.readChat("solidjs general", 10)).resolves.toEqual([]);
  });
});

describe("the send-verification probe", () => {
  it("skips emoji, which the composer renders as images", () => {
    // The field case: a weather report opening with an emoji could never
    // match its own first characters in textContent, so the send died with
    // "could not type into the composer" while a plain "hi" sailed through.
    const probe = sendProbe(
      "🌤️ Weather for Bengaluru: 30°C, clouds and sun 🌞\nHumidity 45%"
    );

    expect(probe).toBe("Weather for Bengaluru: 30°C, clouds and");
  });

  it("uses the raw head when a message is all emoji", () => {
    expect(sendProbe("👍🎉")).toBe("👍🎉");
  });

  it("leaves a plain message's head alone", () => {
    expect(sendProbe("hi there")).toBe("hi there");
  });
});

describe("opening a bare server id", () => {
  // A bare server id used to navigate to /channels/<gid> and hope. Discord
  // often lands that on the Server Guide, which has no composer, so a
  // routine's send to "the server" died with "did not load" and asked the
  // user for a channel id they should never need.
  it("resolves to the crawl's first channel for that server", async () => {
    const { c } = connector();
    const inner = c as unknown as {
      guilds: Array<{ guildId: string; name: string; mentions: number }>;
      guildChannels: Map<string, Array<{ chatId: string; name: string }>>;
      run: (script: string, args: Record<string, unknown>) => Promise<unknown>;
      ensureWindow: () => unknown;
      waitForChat: () => Promise<boolean>;
      openChat: (
        chatId: string
      ) => Promise<{ onGuildPage: boolean; ready: boolean }>;
    };
    inner.guilds = [{ guildId: "22", name: "SolidJS", mentions: 0 }];
    inner.guildChannels.set("22", [
      { chatId: "22/701", name: "#general (SolidJS)" },
      { chatId: "22/702", name: "#help (SolidJS)" },
    ]);
    inner.ensureWindow = () => ({ isDestroyed: () => false });
    inner.waitForChat = async () => true;

    const opened: string[] = [];
    inner.run = async (script: string, args: Record<string, unknown>) => {
      if (typeof args.href === "string") {
        opened.push(args.href);
        return { found: true };
      }
      return null;
    };

    const result = await inner.openChat("22");

    expect(opened).toEqual(["/channels/22/701"]);
    expect(result.onGuildPage).toBe(true);
    expect(result.ready).toBe(true);
  });
});

describe("the mention sweep", () => {
  const guilds = (mentions: number) => [
    { guildId: "22", name: "SolidJS", mentions },
  ];

  it("reports a new mention count once, and again only when it changes", async () => {
    const { c, messages } = connector();
    const inner = internals(c);
    let rows = guilds(2);
    inner.run = async () => rows;

    // The first sweep primes the ledger silently; everything it sees
    // predates the connector, like the DM sweep's first pass.
    inner.firstInboundSweep = true;
    await inner.sweepGuildMentions();
    expect(messages).toHaveLength(0);

    inner.firstInboundSweep = false;
    await inner.sweepGuildMentions();
    expect(messages).toHaveLength(0); // unchanged count, already reported

    rows = guilds(3);
    await inner.sweepGuildMentions();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      chatId: "22",
      userName: "SolidJS",
      text: "SolidJS has 3 unread mention(s)",
    });

    await inner.sweepGuildMentions();
    expect(messages).toHaveLength(1); // still 3, nothing new to say
  });

  it("stays quiet for servers with no mentions", async () => {
    const { c, messages } = connector();
    const inner = internals(c);
    inner.run = async () => guilds(0);
    inner.firstInboundSweep = false;
    await inner.sweepGuildMentions();
    expect(messages).toHaveLength(0);
  });
});

describe("search scoping", () => {
  const scoped = (
    c: DiscordWebConnector
  ): { scopes: string[]; texts: string[] } => {
    const inner = internals(c) as unknown as {
      loggedIn: boolean;
      searchInScope: (
        scope: string,
        text: string,
        limit: number
      ) => Promise<unknown[]>;
      goHome: () => Promise<void>;
    };
    inner.loggedIn = true;
    const scopes: string[] = [];
    const texts: string[] = [];
    inner.searchInScope = async (scope, text) => {
      scopes.push(scope);
      texts.push(text);
      return [];
    };
    inner.goHome = async () => {};
    return { scopes, texts };
  };

  it("uses an explicit scope over everything else", async () => {
    const { c } = connector();
    const seen = scoped(c);
    await c.searchMessages("hello", 5, "99");
    expect(seen.scopes).toEqual(["99"]);
    expect(seen.texts).toEqual(["hello"]);
  });

  it("parses an in: prefix off the query", async () => {
    const { c } = connector();
    const seen = scoped(c);
    await c.searchMessages("in:42 release notes", 5);
    expect(seen.scopes).toEqual(["42"]);
    expect(seen.texts).toEqual(["release notes"]);
  });

  it("walks the joined servers when unscoped, capped", async () => {
    const { c } = connector();
    const inner = internals(c);
    inner.guilds = Array.from({ length: 8 }, (_, i) => ({
      guildId: String(i + 1),
      name: `g${i + 1}`,
      mentions: 0,
    }));
    const seen = scoped(c);
    await c.searchMessages("hooks", 50);
    expect(seen.scopes).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("returns nothing for an empty query", async () => {
    const { c } = connector();
    const seen = scoped(c);
    await expect(c.searchMessages("   ", 5, "99")).resolves.toEqual([]);
    expect(seen.scopes).toEqual([]);
  });
});

describe("every navigation", () => {
  it("carries the plain-Chrome user agent", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "discord-web-connector.ts"),
      "utf8"
    );
    const loads = source.split("loadURL(").length - 1;
    const masked = source.split("userAgent: userAgent()").length - 1;
    expect(loads).toBeGreaterThan(0);
    expect(masked).toBe(loads);
  });
});
