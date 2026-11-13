/**
 * Connected sites: the sites the user is signed in to in the bot's browser,
 * and whether bots may use each sign-in (spec: the user signs in once, in
 * the browser pane; their password never reaches a model).
 *
 * A site joins the list when the browser shows its sign-in page (a password
 * field), whoever opened it: the user browsing in the pane or a bot; when a
 * sign-in page sends the tab back to it (single sign-on); when a bot's run
 * stopped at its sign-in page for the user; or when the user adds it in
 * Settings. Guessing from cookie names
 * would list every shop that sets an anonymous session cookie, so the list
 * is only what is known; a site stays listed while the browser still holds
 * cookies for it. Each has a rule: ask first (the default), allowed, or
 * blocked (the default for banks, payments, health and government).
 *
 * The rule is checked by the app before a browser tool acts on or reads a
 * page of the site, never left to the model.
 */
import fs from "node:fs";
import path from "node:path";

import type {
  ConnectedSite,
  ConnectedSitePolicy,
} from "@abacus-ai/contract/contracts";

import { registrableDomain } from "../vault/site";

/** The saved browser session the pane and every bot's browser use. */
export const BROWSER_PARTITION = "persist:browser-runtime";

/** The browser session's cookie and storage calls this needs (Electron's `Session`, in the app). */
export interface SiteStore {
  cookies: {
    get(filter: { domain?: string }): Promise<
      Array<{
        name: string;
        domain?: string;
        path?: string;
        secure?: boolean;
      }>
    >;
    remove(url: string, name: string): Promise<void>;
  };
  clearStorageData(options: { origin: string }): Promise<void>;
}

/** How the user answered "may this chat use your sign-in on <site>?". */
export type SiteDecision = "allow" | "deny" | "session" | "always";

export interface ConnectedSitesDeps {
  /** Where the list and rules are kept. */
  file: () => string;
  store: () => SiteStore;
  /** Asks the user in the chat; resolves "deny" when nobody can answer. */
  ask: (site: string, sessionId: string) => Promise<SiteDecision>;
  /** The conversation a session belongs to, for "allow in this chat". */
  conversationOf: (sessionId: string) => string | null;
  /**
   * Whether the session is the user's own chat. A contact's chat (or a run
   * nobody watches) never uses the user's sign-ins, whatever the rule says.
   */
  isOwnChat: (sessionId: string) => boolean;
  now?: () => number;
}

/**
 * Sites whose sign-in starts blocked: money, health and government, where a
 * mistaken click costs the most. Matched on the registrable domain.
 */
const SENSITIVE_WORDS =
  /bank|banking|paypal|razorpay|paytm|phonepe|stripe|wise|revolut|venmo|zelle|cashapp|coinbase|binance|zerodha|groww|upstox|robinhood|fidelity|vanguard|schwab|etrade|amex|americanexpress|visa|mastercard|health|clinic|hospital|pharmacy|insurance|irs|incometax|epfo|uidai|digilocker/i;
const SENSITIVE_SUFFIX = /\.(?:gov|gov\.[a-z]{2}|gouv\.[a-z]{2}|nic\.in|mil)$/i;

export const defaultPolicy = (site: string): ConnectedSitePolicy =>
  SENSITIVE_SUFFIX.test(`.${site}`) || SENSITIVE_WORDS.test(site)
    ? "blocked"
    : "ask";

/** A "no" stands this long in one chat, so a retry right after does not ask again. */
const DENIED_FOR_MS = 2 * 60_000;
/** How long after a chat's bot stopped at a site's sign-in page the user's sign-in there counts as their yes (a paused run's life). */
const SIGNED_IN_FOR_CHAT_MS = 45 * 60_000;

interface Saved {
  sites: Record<
    string,
    { policy: ConnectedSitePolicy; addedAt: number; lastUsedAt?: number }
  >;
}

export class ConnectedSites {
  /** "conversation|site" allowed until the app quits. */
  private readonly allowedInChat = new Set<string>();
  /** Sites allowed in every chat until the app quits. */
  private readonly allowedUntilQuit = new Set<string>();
  private readonly deniedInChat = new Map<string, number>();
  /** "conversation|site": that chat's bot stopped at the site's sign-in page, when. */
  private readonly signInAsked = new Map<string, number>();
  /** One prompt per chat and site at a time; later calls share its answer. */
  private readonly asking = new Map<string, Promise<SiteDecision>>();

  constructor(private readonly deps: ConnectedSitesDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private read(): Saved {
    try {
      const saved = JSON.parse(
        fs.readFileSync(this.deps.file(), "utf8")
      ) as Saved;
      return saved?.sites != null ? saved : { sites: {} };
    } catch {
      return { sites: {} };
    }
  }

  private write(saved: Saved): void {
    fs.mkdirSync(path.dirname(this.deps.file()), { recursive: true });
    fs.writeFileSync(this.deps.file(), JSON.stringify(saved, null, 2), {
      mode: 0o600,
    });
  }

  /** The site a URL or host is on, or null (an IP, localhost, not http). */
  siteOf(urlOrHost: string): string | null {
    let host = urlOrHost.trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(host)) {
      try {
        const url = new URL(host);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        host = url.hostname;
      } catch {
        return null;
      }
    }
    host = host.split(/[/?#:]/)[0] ?? "";
    return host.length === 0 ? null : registrableDomain(host);
  }

  // Every cookie, grouped here: Electron's `domain` filter leaves out a
  // host-only cookie a subdomain set (`shop.example.com` for `example.com`),
  // which is how most sign-ins are kept.
  private async cookiesOf(site: string) {
    return (await this.deps.store().cookies.get({})).filter(
      (cookie) =>
        cookie.domain != null &&
        this.siteOf(cookie.domain.replace(/^\./, "")) === site
    );
  }

  /**
   * A bot's browser reached the site's sign-in page in this chat: the site is
   * listed, and the sign-in the user then makes there for it counts as their
   * yes in this chat, so they are not asked again right after.
   */
  signInPage(urlOrHost: string, sessionId: string): void {
    const site = this.add(urlOrHost);
    if (site == null || !this.deps.isOwnChat(sessionId)) return;
    const chat = this.deps.conversationOf(sessionId) ?? sessionId;
    this.signInAsked.set(`${chat}|${site}`, this.now());
  }

  /** Adds a site the user signed in to (or is about to); null when it is not a site. */
  add(urlOrHost: string): string | null {
    const site = this.siteOf(urlOrHost);
    if (site == null) return null;
    const saved = this.read();
    if (saved.sites[site] == null) {
      saved.sites[site] = { policy: defaultPolicy(site), addedAt: this.now() };
      this.write(saved);
    }
    return site;
  }

  /** The listed sites the browser still holds cookies for, newest first. */
  async list(): Promise<ConnectedSite[]> {
    const saved = this.read();
    const out: ConnectedSite[] = [];
    for (const [site, entry] of Object.entries(saved.sites)) {
      if ((await this.cookiesOf(site)).length === 0) continue;
      out.push({
        site,
        policy: entry.policy,
        addedAt: entry.addedAt,
        ...(entry.lastUsedAt != null ? { lastUsedAt: entry.lastUsedAt } : {}),
      });
    }
    return out.sort((a, b) => b.addedAt - a.addedAt);
  }

  setPolicy(site: string, policy: ConnectedSitePolicy): void {
    const saved = this.read();
    const entry = saved.sites[site];
    if (entry == null) return;
    entry.policy = policy;
    this.write(saved);
    if (policy !== "allowed") {
      this.allowedUntilQuit.delete(site);
      for (const key of this.allowedInChat)
        if (key.endsWith(`|${site}`)) this.allowedInChat.delete(key);
    }
  }

  /** Signs the browser out of the site (its cookies and storage) and drops it from the list. */
  async signOut(site: string): Promise<void> {
    const store = this.deps.store();
    const cookies = await this.cookiesOf(site);
    const origins = new Set<string>([`https://${site}`, `https://www.${site}`]);
    await Promise.all(
      cookies.map((cookie) => {
        const host = (cookie.domain ?? site).replace(/^\./, "");
        origins.add(`https://${host}`);
        const url = `${cookie.secure === false ? "http" : "https"}://${host}${cookie.path ?? "/"}`;
        return store.cookies.remove(url, cookie.name).catch(() => undefined);
      })
    );
    for (const origin of origins)
      await store.clearStorageData({ origin }).catch(() => undefined);
    this.forget(site);
  }

  /** Forgets every site (the browser's data was cleared). */
  clear(): void {
    this.write({ sites: {} });
    this.allowedInChat.clear();
    this.allowedUntilQuit.clear();
    this.deniedInChat.clear();
    this.signInAsked.clear();
  }

  private forget(site: string): void {
    const saved = this.read();
    delete saved.sites[site];
    this.write(saved);
    this.allowedUntilQuit.delete(site);
  }

  /**
   * Why a browser call on `url` may not run now, or null when it may: the
   * page is on a listed site the browser is signed in to, and its rule says
   * no, or says ask and the user did not allow it in this chat.
   */
  async gate(url: string, sessionId: string): Promise<string | null> {
    const site = this.siteOf(url);
    if (site == null) return null;
    const saved = this.read();
    const entry = saved.sites[site];
    if (entry == null) return null;
    if ((await this.cookiesOf(site)).length === 0) return null;
    if (!this.deps.isOwnChat(sessionId))
      return `Only the user's own chats can use their sign-in on ${site}; this chat is not theirs. Do not use ${site} here.`;
    const touch = (): null => {
      const fresh = this.read();
      const kept = fresh.sites[site];
      if (kept != null) {
        kept.lastUsedAt = this.now();
        this.write(fresh);
      }
      return null;
    };
    if (entry.policy === "blocked")
      return `The user blocked bots from using their sign-in on ${site} (Settings → Browser → Connected sites). Do not use ${site}: tell the user, and that they can change it there.`;
    if (entry.policy === "allowed") return touch();
    const chat = this.deps.conversationOf(sessionId) ?? sessionId;
    const key = `${chat}|${site}`;
    if (this.allowedUntilQuit.has(site) || this.allowedInChat.has(key))
      return touch();
    // The user signed in because this chat's bot asked them to: that is their yes here.
    const asked = this.signInAsked.get(key);
    if (asked != null && this.now() - asked < SIGNED_IN_FOR_CHAT_MS) {
      this.signInAsked.delete(key);
      this.allowedInChat.add(key);
      return touch();
    }
    const deniedAt = this.deniedInChat.get(key);
    if (deniedAt != null && this.now() - deniedAt < DENIED_FOR_MS)
      return this.refusal(site);
    let pending = this.asking.get(key);
    if (pending == null) {
      pending = this.deps.ask(site, sessionId);
      this.asking.set(key, pending);
      void pending.finally(() => this.asking.delete(key));
    }
    const decision = await pending;
    if (decision === "deny") {
      this.deniedInChat.set(key, this.now());
      return this.refusal(site);
    }
    if (decision === "always") this.setPolicy(site, "allowed");
    else if (decision === "session") this.allowedUntilQuit.add(site);
    else this.allowedInChat.add(key);
    return touch();
  }

  private refusal(site: string): string {
    return `The user did not allow using their sign-in on ${site} for this (or could not be asked: the prompt shows in the app). Do not use ${site}. Tell the user, and that they can allow it when the app asks, or in Settings → Browser → Connected sites.`;
  }
}
