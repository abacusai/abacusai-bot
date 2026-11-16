import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ConnectedSites,
  defaultPolicy,
  importedPartitionForTab,
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
  options: { seedExisting?: boolean; profiles?: Record<string, Cookie[]> } = {}
) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sites-"));
  const jar = [...cookies];
  const cleared: string[] = [];
  const { profiles = {}, ...rest } = options;
  const makeStore = (jar: Cookie[]): SiteStore => ({
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
  });
  const store = makeStore(jar);
  /** An imported browser profile's jar, by its partition. */
  const profileStores = new Map(
    Object.entries(profiles).map(([partition, cookies]) => [
      partition,
      makeStore(cookies),
    ])
  );
  const ask = vi.fn(typeof answer === "function" ? answer : async () => answer);
  let now = 1_000_000;
  const sites = new ConnectedSites({
    file: () => path.join(dir, "connected-sites.json"),
    store: (partition) =>
      partition == null ? store : (profileStores.get(partition) ?? store),
    ask,
    conversationOf: (sessionId) => `chat-${sessionId.split("/")[0]}`,
    // "contact/…" sessions are a contact's chat with the bot.
    isOwnChat: (sessionId) => !sessionId.startsWith("contact"),
    now: () => now,
    ...rest,
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
      /said no to using their sign-in on goindigo\.in/
    );
    expect(await sites.gate("https://goindigo.in/", "1/s")).not.toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("a clear no is told as the user's no, never as a prompt nobody answered", async () => {
    const { sites } = setup([INDIGO], "deny");
    sites.add("goindigo.in");
    const refusal = await sites.gate("https://goindigo.in/", "1/s");
    expect(refusal).toMatch(/said no/);
    expect(refusal).not.toMatch(/could not be asked|nobody|did not answer/i);
  });

  it("a prompt nobody could answer is told as that, not as the user's no, and is not asked again right away", async () => {
    const { sites, ask } = setup([INDIGO], "unasked");
    sites.add("goindigo.in");
    const refusal = await sites.gate("https://goindigo.in/", "1/s");
    expect(refusal).toMatch(/could not be asked/);
    expect(refusal).not.toMatch(/did not allow|said no/);
    expect(await sites.gate("https://goindigo.in/", "1/s")).toMatch(
      /could not be asked/
    );
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
        "said no"
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

  it("names the site a page uses the user's sign-in on, only while it is listed and signed in", async () => {
    const { sites, jar } = setup([INDIGO]);
    expect(await sites.signedInOn("https://www.goindigo.in/trips")).toBeNull();
    sites.add("goindigo.in");
    expect(await sites.signedInOn("https://www.goindigo.in/trips")).toBe(
      "goindigo.in"
    );
    expect(await sites.signedInOn("https://example.com/")).toBeNull();
    jar.length = 0;
    expect(await sites.signedInOn("https://www.goindigo.in/trips")).toBeNull();
  });

  it("ignores what is not a website", () => {
    const { sites } = setup([]);
    expect(sites.add("about:blank")).toBeNull();
    expect(sites.add("localhost")).toBeNull();
    expect(sites.add("Goindigo.in")).toBe("goindigo.in");
  });
});

describe("an imported browser profile (the user's Chrome sign-ins)", () => {
  // A chat's browser on an imported Chrome profile used every sign-in it
  // holds with no rule: the rules read only the app's own browser.
  const CHROME = "persist:bp-chrome-1";
  const chrome = (): Cookie[] => [
    { name: "auth_token", domain: ".goindigo.in" },
    { name: "SID", domain: ".icicibank.com" },
    { name: "_ga", domain: ".news.example" },
  ];

  it("holds a bot on that profile to the rules: asked first, and a bank is blocked", async () => {
    const { sites, ask } = setup([], "deny", {
      profiles: { [CHROME]: chrome() },
    });
    expect(
      await sites.gate("https://www.goindigo.in/trips", "1/s", CHROME)
    ).toMatch(/said no/);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(await sites.gate("https://icicibank.com/", "1/s", CHROME)).toMatch(
      /blocked/
    );
    expect(await sites.gate("https://news.example/", "1/s", CHROME)).toBeNull();
    // The app's own browser holds none of these: no rule there.
    expect(await sites.gate("https://www.goindigo.in/", "2/s")).toBeNull();
  });

  it("shows those sign-ins in Connected sites, so the user can set their rules", async () => {
    const { sites } = setup([], "allow", { profiles: { [CHROME]: chrome() } });
    await sites.gate("https://example.org/", "1/s", CHROME);
    const listed = await sites.list();
    expect(listed.map((s) => s.site).sort()).toEqual([
      "goindigo.in",
      "icicibank.com",
    ]);
    sites.setPolicy("goindigo.in", "allowed");
    expect(await sites.gate("https://goindigo.in/", "1/s", CHROME)).toBeNull();
  });

  it("tells a run the page shows the user's account there", async () => {
    const { sites } = setup([], "allow", { profiles: { [CHROME]: chrome() } });
    expect(await sites.signedInOn("https://goindigo.in/trips", CHROME)).toBe(
      "goindigo.in"
    );
    expect(await sites.signedInOn("https://goindigo.in/trips")).toBeNull();
  });

  it("lists a profile's sign-ins again once it is imported again", async () => {
    const jar = chrome();
    const { sites } = setup([], "allow", { profiles: { [CHROME]: jar } });
    await sites.gate("https://example.org/", "1/s", CHROME);
    jar.push({ name: "session", domain: ".notes.io" });
    await sites.gate("https://example.org/", "1/s", CHROME);
    expect((await sites.list()).map((s) => s.site)).not.toContain("notes.io");
    sites.profileImported(CHROME);
    await sites.gate("https://example.org/", "1/s", CHROME);
    expect((await sites.list()).map((s) => s.site)).toContain("notes.io");
  });

  it("signs the profile out of a site too", async () => {
    const jar = chrome();
    const { sites } = setup([], "allow", { profiles: { [CHROME]: jar } });
    await sites.gate("https://example.org/", "1/s", CHROME);
    await sites.signOut("goindigo.in");
    expect(jar.some((c) => c.domain.endsWith("goindigo.in"))).toBe(false);
    expect((await sites.list()).map((s) => s.site)).toEqual(["icicibank.com"]);
  });
});

describe("the saved list, when its writes overlap", () => {
  const CHROME = "persist:bp-chrome-1";

  it("keeps a site added while a profile's sign-ins are being listed, and lists a profile again when it is re-imported mid-listing", async () => {
    const jar: Cookie[] = [{ name: "auth_token", domain: ".goindigo.in" }];
    const { sites, store } = setup([], "allow", {
      profiles: { [CHROME]: jar },
    });
    // The profile's cookies arrive late: the list is written meanwhile.
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const profileStore = (
      sites as unknown as {
        deps: { store: (p?: string) => typeof store };
      }
    ).deps.store(CHROME);
    const get = profileStore.cookies.get;
    vi.mocked(get).mockImplementationOnce(async () => {
      const before = [...jar];
      await slow;
      return before;
    });
    const first = sites.gate("https://example.org/", "1/s", CHROME);
    await new Promise((resolve) => setTimeout(resolve, 0));
    sites.add("notes.io");
    jar.push({ name: "session", domain: ".notes.io" });
    jar.push({ name: "sid", domain: ".mail.app" });
    const reimported = sites.profileImported(CHROME);
    release();
    await first;
    await reimported;
    await sites.gate("https://example.org/", "1/s", CHROME);
    const listed = (await sites.list()).map((s) => s.site).sort();
    // notes.io was added by hand mid-listing; mail.app came with the re-import.
    expect(listed).toEqual(["goindigo.in", "mail.app", "notes.io"]);
  });

  it("does not bring sites back when the browser's data is cleared mid-listing", async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sites, store } = setup([INDIGO], "allow", { seedExisting: true });
    vi.mocked(store.cookies.get).mockImplementationOnce(async () => {
      await slow;
      return [INDIGO];
    });
    const listing = sites.list();
    await new Promise((resolve) => setTimeout(resolve, 0));
    sites.clear();
    release();
    await listing;
    expect(await sites.list()).toEqual([]);
  });
});

describe("which browser session a tab's sign-ins are in", () => {
  it("looks a tab up only on the built-in browser, never a Chrome tab id", () => {
    const lookup = vi.fn((id: number) =>
      id === 7 ? "persist:bp-chrome-1" : null
    );
    expect(importedPartitionForTab("builtin", 7, lookup)).toBe(
      "persist:bp-chrome-1"
    );
    expect(importedPartitionForTab("builtin", 8, lookup)).toBeUndefined();
    expect(
      importedPartitionForTab("builtin", undefined, lookup)
    ).toBeUndefined();
    lookup.mockClear();
    expect(importedPartitionForTab("chrome", 7, lookup)).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("a sign-in kept only in page storage (no cookies)", () => {
  // A site keeping its sign-in as a token in localStorage or IndexedDB has
  // no cookies: it was used with no rule, and never found among earlier
  // sign-ins. The page's storage is read in the page, by the browser.
  const keys = (...names: string[]) =>
    vi.fn(async () => ({ keys: names, tokens: [] as string[] }));
  /** Keys whose values look like a sign-in token (a JWT), as the page says. */
  const tokens = (...names: string[]) =>
    vi.fn(async () => ({ keys: names, tokens: names }));

  it("holds a listed site to its rule when the page holds storage", async () => {
    const { sites, ask } = setup([], "deny");
    sites.add("notes.app");
    expect(
      await sites.gate(
        "https://notes.app/",
        "1/s",
        undefined,
        keys("auth_token")
      )
    ).toMatch(/said no/);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(
      await sites.gate("https://notes.app/", "2/s", undefined, keys())
    ).toBeNull();
  });

  it("lists an unlisted site whose page keeps a sign-in token, and asks before anything is read", async () => {
    const { sites, ask } = setup([], "deny");
    for (const name of [
      "access_token",
      "firebase:authUser:x",
      "jwt",
      "firebaseLocalStorageDb",
    ]) {
      const site = `${name.replace(/[^a-z]/gi, "")}.example`;
      expect(
        await sites.gate(
          `https://${site}/`,
          "1/s",
          undefined,
          keys("theme", name)
        )
      ).toMatch(/said no/);
    }
    expect(ask).toHaveBeenCalledTimes(4);
    const listed = await sites.list();
    expect(listed.map((s) => s.site)).toContain("accesstoken.example");
    expect(listed.find((s) => s.site === "accesstoken.example")?.policy).toBe(
      "ask"
    );
  });

  it("lists a site whose page keeps a token-shaped value, whatever the key is called", async () => {
    const { sites, ask } = setup([], "deny");
    expect(
      await sites.gate("https://app.example/", "1/s", undefined, tokens("st"))
    ).toMatch(/said no/);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("never lists a public site a visitor is not signed in to (its real keys)", async () => {
    // Keys these sites set for a visitor who is not signed in (16 Nov).
    const visitor: Record<string, string[]> = {
      "booking.com": [
        "aws_waf_token_challenge_attempts",
        "awswaf_session_storage",
        "awswaf_token_refresh_timestamp",
        "_uetsid",
        "pacs_data",
      ],
      "wikipedia.org": ["portal_session_id", "translationHash"],
      "amazon.in": ["csa-ctoken-YE4V643Q51YJE5E83P19", "csm-hit", "amznfbgid"],
      "flipkart.com": ["NRBA_SESSION::b2b54ff9", "keyval-store", "v4-database"],
      "bbc.com": [
        "permutiveIdentityManagerId_exp",
        "_sp_user_consent_26225",
        "fedIDpiano",
      ],
    };
    const { sites, ask } = setup([]);
    for (const [site, names] of Object.entries(visitor))
      expect(
        await sites.gate(
          `https://www.${site}/`,
          "1/s",
          undefined,
          keys(...names)
        )
      ).toBeNull();
    expect(ask).not.toHaveBeenCalled();
    expect(await sites.list()).toEqual([]);
  });

  it("never lists a site on analytics or preferences alone", async () => {
    const { sites, ask } = setup([]);
    expect(
      await sites.gate(
        "https://news.example/",
        "1/s",
        undefined,
        keys(
          "_ga",
          "amplitude_unsent",
          "ajs_user_id",
          "_hjSession_1",
          "mp_x_mixpanel",
          "theme"
        )
      )
    ).toBeNull();
    expect(ask).not.toHaveBeenCalled();
    expect(await sites.list()).toEqual([]);
  });

  it("treats a page that blocks or throws on storage as holding nothing", async () => {
    const { sites, ask } = setup([]);
    sites.add("notes.app");
    const throws = vi.fn(async () => {
      throw new Error("SecurityError");
    });
    expect(
      await sites.gate("https://notes.app/", "1/s", undefined, throws)
    ).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  it("reads the page only when cookies do not already answer", async () => {
    const { sites } = setup([INDIGO]);
    sites.add("goindigo.in");
    const read = keys("auth_token");
    await sites.gate("https://goindigo.in/", "1/s", undefined, read);
    expect(read).not.toHaveBeenCalled();
  });

  it("tells a run the page shows the user's account, and keeps the site in Settings", async () => {
    const { sites } = setup([]);
    await sites.gate("https://notes.app/", "1/s", undefined, keys("id_token"));
    expect(
      await sites.signedInOn("https://notes.app/x", undefined, keys("id_token"))
    ).toBe("notes.app");
    expect(await sites.signedInOn("https://notes.app/x")).toBeNull();
    expect((await sites.list()).map((s) => s.site)).toEqual(["notes.app"]);
  });
});
