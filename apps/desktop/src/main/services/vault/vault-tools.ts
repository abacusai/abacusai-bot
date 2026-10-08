/**
 * The vault as the agent sees it: `vault_items`, `vault_request` and
 * `payment_approval` for the conversation's own agent, and the schema of
 * `browser_vault_fill`, which the browser server runs for its sub-agent.
 * Request and approval ids stay in `VaultSessions`; no tool takes one.
 */
import type { McpToolListing, McpToolResult } from "../mcp/mcp-http-server";
import {
  VAULT_UNAVAILABLE,
  type VaultClient,
  type VaultItem,
  type VaultRequestKind,
} from "./vault-client";
import { httpsHost, isPaymentFrameOrigin } from "./vault-fill";
import {
  REQUEST_LIFETIME_MS,
  VaultSessions,
  type PaymentApproval,
} from "./vault-session";
import { VaultWaiter } from "./vault-waiter";

const withinSite = (host: string, site: string): boolean =>
  site.length > 0 && (host === site || host.endsWith(`.${site}`));

export const VAULT_FILL_TOOL = "browser_vault_fill";

const TOOLS: Record<
  string,
  { description: string; inputSchema: Record<string, unknown> }
> = {
  vault_items: {
    description: [
      "The user's saved logins and cards in their encrypted vault: item ids, labels, sites,",
      "card brand, last 4 digits and expiry. Never a password, card number or CVV: those are",
      "typed into pages by the browser and never pass through you.",
      "",
      "Look here before asking for a login (one may be saved for the site) and to pick the",
      "card for payment_approval.",
    ].join("\n"),
    inputSchema: { type: "object", properties: {} },
  },
  vault_request: {
    description: [
      "Get a password, card or one-time code from the user without it passing through this chat:",
      "returns a one-time link to send them. They type it on that page, it goes into their",
      "encrypted vault, and you are told when they are done; carry on meanwhile.",
      "",
      "Never ask for a password, card number, CVV or code in the chat, and never use one typed",
      "there. When a site needs one, send this link instead:",
      '- kind "login" with the site (e.g. "linkedin.com"), when a site needs the user signed in',
      "  and vault_items has no login for it.",
      '- kind "card", when the user wants you to pay and has no card saved.',
      '- kind "code" with the login\'s item_id, for a sign-in code the site sent them; or kind',
      '  "code" with no item_id for the bank\'s code (3-D Secure) of the payment they approved,',
      "  while the browser is on the page asking for it.",
      "",
      "Once a login is saved, pass its item_id to browser_task as login_item_id: its browser",
      "signs in with browser_vault_fill. The link works once, only for this user, for 30",
      "minutes. Only the user opens it: the browser never opens Abacus.AI pages.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["login", "card", "code"],
          description: "What the user is asked for",
        },
        site: {
          type: "string",
          description:
            'For a login: the site it is for, e.g. "linkedin.com". For a sign-in code, optional.',
        },
        item_id: {
          type: "string",
          description:
            "For a sign-in code: the saved login it is for. Omit for the bank's code of an approved payment.",
        },
      },
      required: ["kind"],
    },
  },
  payment_approval: {
    description: [
      "Ask the user to approve one payment with a saved card: returns a one-time link to send",
      "them, whose page shows the amount, merchant and site and asks them to approve it (with",
      "the CVV only when the checkout asks for one). Use it only at the checkout's review step,",
      "once the browser has reported the exact total, on the checkout page the browser is on now.",
      "",
      "Once approved, the browser can fill that card's number (and CVV) for exactly that amount",
      "on that site, once each, within 10 minutes; you are told when they approve. If the total",
      "changes, ask again. Never ask for a card number or CVV in the chat, and never open the",
      "link in the browser: approving is the user's alone.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        item_id: {
          type: "string",
          description: "The saved card, from vault_items",
        },
        merchant: {
          type: "string",
          description:
            'Who is paid, as the checkout names them, e.g. "Akasa Air"',
        },
        amount: {
          type: "string",
          description:
            'The exact total the checkout shows, digits only with a decimal point, e.g. "1234.00"',
        },
        currency: {
          type: "string",
          description: 'The ISO 4217 code, e.g. "INR" or "USD"',
        },
        cvv_required: {
          type: "boolean",
          description: "Whether the checkout asks for a CVV",
        },
      },
      required: ["item_id", "merchant", "amount", "currency"],
    },
  },
  [VAULT_FILL_TOOL]: {
    description: [
      "Type one of the user's saved vault values into a field, without you ever seeing it:",
      "username, password, a sign-in code, card_number or cvv. Give the item_id your task names",
      "and the field's ref from a snapshot. The browser reads the page's own origin and the",
      "vault checks it against the item, so it only works on the site the value belongs to.",
      "Each value goes only into its own kind of field: a password into the password field, a",
      "username into the sign-in form's username or email field, a code into the one-time code",
      "field, card values into the checkout's card fields; never a search box or text area.",
      "",
      'To sign in, use field "login" with no ref: the browser finds the sign-in form itself,',
      "fills the username and the password, and names the button to click. On a sign-in that",
      "asks for the username first, it fills that and says the password is pending: go on to",
      "the next step and call it again.",
      "",
      "Card number and CVV fill only after the user approved this payment, once each: pass",
      "total_ref, the ref of the element showing the order total with its currency. The",
      "browser reads that total itself and refuses if it differs from the approved amount.",
      "Expiry and name on card are not secret: fill those with",
      "browser_interact. Afterwards the field reads (hidden) everywhere.",
      "",
      "Never type a password, card number, CVV or code any other way.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "The vault item" },
        field: {
          type: "string",
          enum: ["login", "username", "password", "code", "card_number", "cvv"],
          description:
            'Which of its values to type; "login" fills the sign-in form\'s username and password',
        },
        ref: {
          type: "string",
          description:
            'The field to type into, e.g. @e12 or @f1e3. Not for "login", which finds its fields.',
        },
        total_ref: {
          type: "string",
          description:
            'Required for card_number and cvv: the ref of the element showing the order total, e.g. "Total ₹1,234.00"',
        },
      },
      required: ["item_id", "field"],
    },
  },
};

export const VAULT_TOOL_NAMES: readonly string[] = Object.keys(TOOLS);

/** What the parent's tools need from the browser: the live page the session drives. */
export interface VaultBrowser {
  /** The live origin of the top-level page of the session's active tab, or null. */
  topOrigin(sessionId: string): Promise<string | null>;
  /**
   * The documents of that tab (its page and its cross-origin frames) that
   * hold a field a one-time code goes into, by live origin.
   */
  codePages(
    sessionId: string
  ): Promise<Array<{ origin: string; top: boolean }>>;
}

export interface VaultDeps {
  client: VaultClient;
  /** Delivers a note to the session's conversation as a turn of its own. */
  deliver: (sessionId: string, note: string) => void;
  now?: () => number;
  everyMs?: number;
}

/** How long a message waits on the check it triggers before going without it. */
const CHECK_BEFORE_MESSAGE_MS = 3_000;

const ok = (text: string): McpToolResult => ({
  content: [{ type: "text", text }],
});
const err = (text: string): McpToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SITE_RE = /^[a-z0-9.-]{1,253}$/i;

const describeItem = (item: VaultItem): string => {
  const parts = [`${item.itemId}: ${item.kind}`];
  if (item.label.length > 0) parts.push(`"${item.label}"`);
  if (item.sites.length > 0) parts.push(`for ${item.sites.join(", ")}`);
  if (item.brand != null || item.last4 != null)
    parts.push(`${item.brand ?? "card"} ending ${item.last4 ?? "?"}`);
  if (item.expiryMonth != null && item.expiryYear != null)
    parts.push(
      `expires ${String(item.expiryMonth).padStart(2, "0")}/${item.expiryYear}`
    );
  if (item.nameOnCard != null) parts.push(`name on card ${item.nameOnCard}`);
  return parts.join(", ");
};

const until = (expiresAt: number | null, now: number): number =>
  expiresAt != null ? expiresAt * 1000 : now + REQUEST_LIFETIME_MS;

export class Vault {
  readonly sessions: VaultSessions;
  readonly waiter: VaultWaiter;
  private readonly now: () => number;

  constructor(private readonly deps: VaultDeps) {
    this.now = deps.now ?? Date.now;
    this.sessions = new VaultSessions(this.now);
    this.waiter = new VaultWaiter({
      client: deps.client,
      sessions: this.sessions,
      raise: (sessionId, note) => this.deps.deliver(sessionId, note),
      now: this.now,
      ...(deps.everyMs != null ? { everyMs: deps.everyMs } : {}),
    });
  }

  get client(): VaultClient {
    return this.deps.client;
  }

  /** The tools, unless the platform has refused the vault for this account. */
  listings(): McpToolListing[] {
    if (!this.deps.client.maybeAvailable()) return [];
    return VAULT_TOOL_NAMES.map((name) => ({ name, ...TOOLS[name]! }));
  }

  /** The approval this session's user granted, while it is good. */
  approval(sessionId: string | undefined): PaymentApproval | null {
    return sessionId == null
      ? null
      : (this.sessions.get(sessionId)?.approved() ?? null);
  }

  /** Runs one of the parent's tools. */
  async run(
    name: string,
    args: Record<string, unknown>,
    sessionId: string | undefined,
    browser: VaultBrowser
  ): Promise<McpToolResult> {
    if (sessionId == null)
      return err("The vault works only inside a conversation.");
    switch (name) {
      case "vault_items":
        return this.items();
      case "vault_request":
        return this.request(args, sessionId, browser);
      case "payment_approval":
        return this.approve(args, sessionId, browser);
      default:
        return err(`Unknown tool: ${name}`);
    }
  }

  /**
   * Before the user's message reaches the session: anything outstanding is
   * checked at once (they may be saying they are done on the page), and what
   * it finds is delivered like any other note. Bounded, so a slow platform
   * never holds the message up for long.
   */
  async checkBeforeMessage(sessionId: string): Promise<string[]> {
    const session = this.sessions.get(sessionId);
    if (session == null || !session.outstanding()) return [];
    const check = this.waiter.checkNow(sessionId).catch(() => []);
    const notes = await Promise.race([
      check,
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), CHECK_BEFORE_MESSAGE_MS).unref?.()
      ),
    ]);
    if (notes != null) return notes;
    // Too slow for this message: what it finds is delivered as any other note.
    void check.then((found) => {
      for (const note of found) this.deps.deliver(sessionId, note);
    });
    return [];
  }

  /**
   * The origin of the bank's page asking for the code, among the tab's
   * documents that hold a one-time code field: the page itself when it left
   * the approved site, else the one frame that is not the merchant's (a
   * payment provider's only when it is the only kind there). Refused when
   * the page does not say which.
   */
  private async bankPageOrigin(
    sessionId: string,
    approval: PaymentApproval,
    browser: VaultBrowser
  ): Promise<string | { error: string }> {
    const pages = await browser.codePages(sessionId);
    const outside = pages.filter((page) => {
      const host = httpsHost(page.origin);
      return host != null && !withinSite(host, approval.site);
    });
    const top = outside.find((page) => page.top);
    if (top != null) return top.origin;
    const frames = [...new Set(outside.map((page) => page.origin))];
    const banks = frames.filter((origin) => !isPaymentFrameOrigin(origin));
    const candidates = banks.length > 0 ? banks : frames;
    if (candidates.length === 1) return candidates[0]!;
    return {
      error:
        candidates.length === 0
          ? "The browser is not on a page with the bank's code field. Have the browser reach the step where the bank asks for the code first."
          : "Several outside frames on the page ask for a code, so which is the bank's is unclear. Report what the page shows.",
    };
  }

  stop(): void {
    this.waiter.stop();
  }

  private unavailable(result: { unavailable: boolean; error: string }) {
    return err(result.unavailable ? VAULT_UNAVAILABLE : result.error);
  }

  private async items(): Promise<McpToolResult> {
    const result = await this.deps.client.listItems();
    if (result.ok === false) return this.unavailable(result);
    if (result.value.length === 0)
      return ok(
        "The vault is empty. Ask for a login or card with vault_request when one is needed."
      );
    return ok(result.value.map(describeItem).join("\n"));
  }

  private async request(
    args: Record<string, unknown>,
    sessionId: string,
    browser: VaultBrowser
  ): Promise<McpToolResult> {
    const kind = args.kind;
    if (kind !== "login" && kind !== "card" && kind !== "code")
      return err('kind must be "login", "card" or "code".');
    const site =
      typeof args.site === "string" && args.site.trim().length > 0
        ? args.site.trim().toLowerCase()
        : null;
    const itemId =
      typeof args.item_id === "string" && args.item_id.trim().length > 0
        ? args.item_id.trim()
        : null;
    if (site != null && !SITE_RE.test(site))
      return err('site is a domain, e.g. "linkedin.com".');
    if (itemId != null && !ITEM_ID_RE.test(itemId))
      return err("That is not a vault item id; vault_items lists them.");
    if (kind === "login" && site == null)
      return err('A login request names the site, e.g. site: "linkedin.com".');

    const session = this.sessions.for(sessionId);
    let input: Parameters<VaultClient["createRequest"]>[0] = {
      kind: kind as VaultRequestKind,
    };
    let forPayment = false;
    // The approval a bank's code is asked for: bound to it only if it still stands once the page exists.
    let codeApproval: PaymentApproval | null = null;
    if (kind === "login") input = { kind, site: site! };
    else if (kind === "code" && itemId != null)
      input = { kind, itemId, ...(site != null ? { site } : {}) };
    else if (kind === "code") {
      // The bank's code: bound to the approved payment and the live page asking for it.
      const approval = session.approved();
      if (approval == null)
        return err(
          "A bank code goes with a payment the user approved, and none is approved now. " +
            "For a sign-in code, pass the login's item_id."
        );
      const origin = await this.bankPageOrigin(sessionId, approval, browser);
      if (typeof origin !== "string") return err(origin.error);
      input = { kind, paymentApprovalId: approval.id, origin };
      forPayment = true;
      codeApproval = approval;
    }

    const result = await this.deps.client.createRequest(input);
    if (result.ok === false) return this.unavailable(result);
    // Bound only once the server bound it, and only to the approval it was
    // asked for: the code is typed only on this origin.
    if (codeApproval != null && input.origin != null) {
      if (session.approved() !== codeApproval)
        return err(
          "The payment approval changed while the code page was being made, so it was not used. Ask for the bank's code again."
        );
      codeApproval.codeOrigin = input.origin;
    }
    const now = this.now();
    session.requests.set(result.value.requestId, {
      requestId: result.value.requestId,
      kind,
      site,
      itemId,
      forPayment,
      expiresAt: until(result.value.expiresAt, now),
    });
    this.waiter.watch();
    const minutes = Math.max(
      1,
      Math.round((until(result.value.expiresAt, now) - now) / 60_000)
    );
    const what =
      kind === "login"
        ? `save their login for ${site}`
        : kind === "card"
          ? "save a card"
          : "type the code";
    return ok(
      `Send the user this link: ${result.value.url}\n` +
        `It opens a one-time page where they ${what}; it works once, only for them, for ${minutes} minutes. ` +
        "You are told when they finish. Carry on meanwhile, and never ask for the value in the chat."
    );
  }

  private async approve(
    args: Record<string, unknown>,
    sessionId: string,
    browser: VaultBrowser
  ): Promise<McpToolResult> {
    const itemId = typeof args.item_id === "string" ? args.item_id.trim() : "";
    const merchant =
      typeof args.merchant === "string" ? args.merchant.trim() : "";
    const amount = typeof args.amount === "string" ? args.amount.trim() : "";
    const currency =
      typeof args.currency === "string"
        ? args.currency.trim().toUpperCase()
        : "";
    if (!ITEM_ID_RE.test(itemId))
      return err("item_id is the saved card's id, from vault_items.");
    if (merchant.length === 0) return err("Name the merchant.");
    if (!/^[0-9]{1,12}(?:\.[0-9]{1,3})?$/.test(amount))
      return err(
        'amount is the exact total as digits with a decimal point, e.g. "1234.00".'
      );
    if (!/^[A-Z]{3}$/.test(currency))
      return err('currency is an ISO 4217 code, e.g. "INR".');
    const origin = await browser.topOrigin(sessionId);
    if (origin == null)
      return err(
        "The browser is not on the checkout. Have it open the checkout's review step first: the approval is bound to that page's site."
      );
    const cvvRequired = args.cvv_required === true;
    const result = await this.deps.client.createPaymentApproval({
      itemId,
      merchant,
      amount,
      currency,
      origin,
      cvvRequired,
    });
    if (result.ok === false) return this.unavailable(result);
    const now = this.now();
    this.sessions.for(sessionId).approval = {
      id: result.value.paymentApprovalId,
      item: itemId,
      merchant,
      amount: result.value.amount,
      currency: result.value.currency,
      site: result.value.site,
      cvvRequired,
      status: "pending",
      used: new Set(),
      codeOrigin: null,
      expiresAt: until(result.value.expiresAt, now),
    };
    this.waiter.watch();
    return ok(
      `Send the user this link to approve paying ${result.value.amount} ${result.value.currency} to ${merchant}` +
        ` on ${result.value.site}: ${result.value.url}\n` +
        "You are told when they approve. Until then no card is filled."
    );
  }
}
