import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ConnectedSites,
  defaultPolicy,
  type SiteDecision,
  type SiteStore,
} from "./connected-sites";

type Cookie = {
  name: string;
  domain: string;
  path?: string;
  secure?: boolean;
  session?: boolean;
};

const setup = (
  cookies: Cookie[],
  answer: SiteDecision | (() => Promise<SiteDecision>) = "allow",
  options: { seedExisting?: boolean } = {}
) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sites-"));
  const jar = [...cookies];
  const cleared: string[] = [];
  const store: SiteStore = {
    cookies: {
      // As Electron does: a host-only cookie (no leading dot) matches only
      // its own host, so `domain: "goindigo.in"` misses one set by a subdomain.
      get: vi.fn(async ({ domain }: { domain?: string }) =>
        jar.filter(
          (c) =>
            domain == null ||
            c.domain === domain ||
            (c.domain.startsWith(".") &&
              (c.domain.slice(1) === domain || domain.endsWith(c.domain)))
        )
      ),
      remove: vi.fn(async (url: string, name: string) => {
        const host = new URL(url).hostname;
        const at = jar.findIndex(
          (c) => c.name === name && c.domain.replace(/^\./, "") === host
        );
        if (at >= 0) jar.splice(at, 1);
      }),
    },
    clearStorageData: vi.fn(async ({ origin }: { origin: string }) => {
      cleared.push(origin);
    }),
  };
  const ask = vi.fn(typeof answer === "function" ? answer : async () => answer);
  let now = 1_000_000;
  const sites = new ConnectedSites({
    file: () => path.join(dir, "connected-sites.json"),
    store: () => store,
    ask,
    conversationOf: (sessionId) => `chat-${sessionId.split("/")[0]}`,
    // "contact/…" sessions are a contact's chat with the bot.
    isOwnChat: (sessionId) => !sessionId.startsWith("contact"),
    now: () => now,
    ...options,
  });
  return {
    sites,
    ask,
    jar,
    cleared,
    store,
    later: (ms: number) => {
      now += ms;
    },
  };
};

const INDIGO = { name: "auth_token", domain: ".goindigo.in" };
/** A host-only cookie, the way a sign-in on a subdomain keeps it. */
const SHOP = { name: "fly_session", domain: "shop.localtest.me" };

describe("connected sites", () => {
  it("lists only sites added (a sign-in stop or the user) that still hold cookies", async () => {
    const { sites } = setup([
      INDIGO,
      { name: "session-id", domain: ".shop.com" },
    ]);
    expect(await sites.list()).toEqual([]);
    sites.add("https://www.goindigo.in/booking");
    sites.add("nocookies.com");
    expect((await sites.list()).map((s) => s.site)).toEqual(["goindigo.in"]);
  });

  it("finds a sign-in a subdomain keeps in a host-only cookie", async () => {
    const { sites } = setup([SHOP]);
    sites.add("localtest.me");
    expect((await sites.list()).map((s) => s.site)).toEqual(["localtest.me"]);
  });

  it("is not a gate for a site never added, or one signed out of", async () => {
    const { sites, ask, jar } = setup([INDIGO]);
    expect(await sites.gate("https://goindigo.in/", "a")).toBeNull();
    sites.add("goindigo.in");
    jar.length = 0;
    expect(await sites.gate("https://goindigo.in/", "a")).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  it("ask first: asks once per chat, and a yes holds in that chat only", async () => {
    const { sites, ask } = setup([INDIGO], "allow");
    sites.add("goindigo.in");
    expect(await sites.gate("https://www.goindigo.in/a", "1/s")).toBeNull();
    expect(await sites.gate("https://goindigo.in/b", "1/s")).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
    await sites.gate("https://goindigo.in/", "2/s");
    expect(ask).toHaveBeenCalledTimes(2);
    expect((await sites.list())[0]!.lastUsedAt).toBeTypeOf("number");
  });

  it("a no is a refusal the bot can tell the user, and is not asked again right away", async () => {
    const { sites, ask } = setup([INDIGO], "deny");
    sites.add("goindigo.in");
    expect(await sites.gate("https://goindigo.in/", "1/s")).toMatch(
      /did not allow using their sign-in on goindigo\.in/
    );
    expect(await sites.gate("https://goindigo.in/", "1/s")).not.toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("'always' makes the site allowed for good; blocked never asks", async () => {
    const { sites, ask } = setup([INDIGO], "always");
    sites.add("goindigo.in");
    await sites.gate("https://goindigo.in/", "1/s");
    expect((await sites.list())[0]!.policy).toBe("allowed");
    expect(await sites.gate("https://goindigo.in/", "9/s")).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
    sites.setPolicy("goindigo.in", "blocked");
    expect(await sites.gate("https://goindigo.in/", "1/s")).toMatch(
      /blocked bots from using their sign-in on goindigo\.in/
    );
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("calls at once share one prompt", async () => {
    let release: (d: SiteDecision) => void = () => {};
    const { sites, ask } = setup(
      [INDIGO],
      () => new Promise<SiteDecision>((r) => (release = r))
    );
    sites.add("goindigo.in");
    const both = Promise.all([
      sites.gate("https://goindigo.in/a", "1/s"),
      sites.gate("https://goindigo.in/b", "1/s"),
    ]);
    await vi.waitFor(() => expect(ask).toHaveBeenCalled());
    release("allow");
    expect(await both).toEqual([null, null]);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("never lets a contact's chat use the user's sign-in, even on an allowed site", async () => {
    const { sites, ask } = setup([INDIGO]);
    sites.add("goindigo.in");
    sites.setPolicy("goindigo.in", "allowed");
    expect(await sites.gate("https://goindigo.in/", "contact/x")).toMatch(
      /Only the user's own chats/
    );
    expect(await sites.gate("https://goindigo.in/", "1/s")).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  it("a sign-in the user made because this chat's bot stopped there is their yes here, once asked for", async () => {
    const { sites, ask, later } = setup([SHOP]);
    sites.signInPage("https://shop.localtest.me/login", "1/s");
    expect(
      await sites.gate("https://shop.localtest.me/account", "1/s")
    ).toBeNull();
    expect(ask).not.toHaveBeenCalled();
    // Another chat is still asked; so is a chat whose stop is long past.
    await sites.gate("https://shop.localtest.me/account", "2/s");
    expect(ask).toHaveBeenCalledTimes(1);
    sites.signInPage("https://shop.localtest.me/login", "3/s");
    later(46 * 60_000);
    await sites.gate("https://shop.localtest.me/account", "3/s");
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("a contact's chat reaching a sign-in page lists the site but earns no yes", async () => {
    const { sites } = setup([SHOP]);
    sites.signInPage("https://shop.localtest.me/login", "contact/x");
    expect((await sites.list()).map((s) => s.site)).toEqual(["localtest.me"]);
    expect(await sites.gate("https://shop.localtest.me/", "contact/x")).toMatch(
      /Only the user's own chats/
    );
  });

  it("money, health and government sites start blocked; others ask first", () => {
    for (const site of [
      "hdfcbank.com",
      "paypal.com",
      "irs.gov",
      "uidai.gov.in",
      "apollohospitals.com",
    ])
      expect(defaultPolicy(site)).toBe("blocked");
    for (const site of ["goindigo.in", "amazon.in", "github.com"])
      expect(defaultPolicy(site)).toBe("ask");
  });

  it("signing out removes the site's cookies and storage and drops it", async () => {
    const { sites, jar, cleared } = setup([
      INDIGO,
      { name: "sid", domain: "book.goindigo.in" },
      { name: "x", domain: ".other.com" },
    ]);
    sites.add("goindigo.in");
    await sites.signOut("goindigo.in");
    expect(jar.map((c) => c.domain)).toEqual([".other.com"]);
    expect(cleared).toContain("https://goindigo.in");
    expect(cleared).toContain("https://book.goindigo.in");
    expect(await sites.list()).toEqual([]);
  });

  describe("sign-ins the browser held before Connected sites", () => {
    // A site the user signed in to before this version was never listed, so
    // no rule applied to it and any bot could use the sign-in.
    const before = [
      INDIGO,
      { name: "__Secure-1PSID", domain: ".google.com" },
      { name: "SESSIONID", domain: "app.notes.io" },
      { name: "_ga", domain: ".shop.com" },
      { name: "consent", domain: ".news.com" },
      { name: "cart", domain: "store.example" },
      { name: "remember_user_token", domain: ".icicibank.com" },
      { name: "visit_session", domain: ".blog.example", session: true },
    ];

    it("lists, once, the sites holding a sign-in cookie, under their default rule", async () => {
      const { sites } = setup(before, "allow", { seedExisting: true });
      const listed = await sites.list();
      expect(listed.map((s) => s.site).sort()).toEqual([
        "goindigo.in",
        "google.com",
        "icicibank.com",
        "notes.io",
      ]);
      expect(listed.find((s) => s.site === "icicibank.com")?.policy).toBe(
        "blocked"
      );
      expect(listed.find((s) => s.site === "google.com")?.policy).toBe("ask");
    });

    it("so a bot is asked before using one", async () => {
      const { sites, ask } = setup(before, "deny", { seedExisting: true });
      expect(await sites.gate("https://www.goindigo.in/trips", "a")).toContain(
        "did not allow"
      );
      expect(ask).toHaveBeenCalledTimes(1);
    });

    it("does not bring back a site the user signed out of", async () => {
      const { sites, jar } = setup(before, "allow", { seedExisting: true });
      await sites.list();
      await sites.signOut("google.com");
      jar.push({ name: "SID", domain: ".google.com" });
      expect((await sites.list()).map((s) => s.site)).not.toContain(
        "google.com"
      );
    });
  });

  it("ignores what is not a website", () => {
    const { sites } = setup([]);
    expect(sites.add("about:blank")).toBeNull();
    expect(sites.add("localhost")).toBeNull();
    expect(sites.add("Goindigo.in")).toBe("goindigo.in");
  });
});
