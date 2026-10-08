/**
 * The only caller of the platform's vault endpoints, with the bot's own
 * Abacus.AI key. Nothing here logs a request or response body: a fill's
 * response carries the value, which goes to the caller that types it and
 * nowhere else. Failures log the method and HTTP status only; the server's
 * own reason (written for the user: "the checkout amount does not match")
 * goes back to the caller, never a value.
 *
 * The endpoints are switched on per account by the platform. A server that
 * refuses them (off for this account, or not there at all) makes the client
 * report the vault unavailable, and the tools say so.
 */
import { credentialFor } from "../config/settings";
import { abacusAppHost, abacusUserAgent } from "../providers/abacus-host";

export type VaultRequestKind = "login" | "card" | "code";
export type VaultField =
  | "username"
  | "password"
  | "code"
  | "card_number"
  | "cvv"
  | "card_exp_month"
  | "card_exp_year"
  | "cardholder_name";
export type VaultRequestStatus = "pending" | "completed" | "failed" | "expired";

/** A saved item as the platform lists it: metadata only, never a value. */
export interface VaultItem {
  itemId: string;
  kind: string;
  label: string;
  sites: string[];
  brand: string | null;
  last4: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  nameOnCard: string | null;
}

export type VaultResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      unavailable: boolean;
      error: string;
      /** The server said it has no such item or value. */
      notFound?: boolean;
    };

export interface VaultClientDeps {
  fetch?: typeof fetch;
  /** The bot's Abacus.AI key; empty when signed out. */
  apiKey?: () => string;
  host?: () => string;
  userAgent?: () => string;
  log?: (line: string) => void;
}

/** What the tools say when the platform will not serve the vault. */
export const VAULT_UNAVAILABLE =
  "The vault is not available for this account, so saved logins and cards cannot be used here.";

const GENERIC_FAILURE = "The vault did not answer. Try again in a moment.";
/** What a server without sign-in approvals says to asking for one: the rest of the vault still works. */
export const SIGNIN_UNSUPPORTED =
  "Sign-in approvals are not supported by this server yet, so a saved login cannot be filled here. Cards and vault pages still work.";
/** The platform's words for "this account has no vault". */
const UNAVAILABLE_RE =
  /not available for this account|only available to AbacusAI Bot/i;
/** Server reasons are short sentences; anything longer is not one. */
const MAX_REASON_CHARS = 300;
/** How long one call may take; a hung call never holds the polling up. */
const CALL_TIMEOUT_MS = 15_000;
/** How long a verdict that the vault is off for this account is believed. */
const UNAVAILABLE_FOR_MS = 10 * 60_000;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
/** A response field under the platform's camelCase name or its snake_case original. */
const field = (record: Record<string, unknown>, camel: string): unknown =>
  record[camel] ??
  record[camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];

export class VaultClient {
  /** Until when the platform is believed to refuse the vault for this account. */
  private unavailableUntil = 0;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: VaultClientDeps = {}) {
    this.fetchFn = deps.fetch ?? ((input, init) => fetch(input, init));
  }

  /** False once the platform refused the vault for this account, for a while. */
  maybeAvailable(now = Date.now()): boolean {
    return this.apiKey().length > 0 && now >= this.unavailableUntil;
  }

  async listItems(): Promise<VaultResult<VaultItem[]>> {
    const result = await this.call("_listAbacusbotVaultItems", "GET");
    if (result.ok === false) return result;
    const rows = Array.isArray(result.value) ? result.value : [];
    return {
      ok: true,
      value: rows.flatMap((row): VaultItem[] => {
        if (row == null || typeof row !== "object") return [];
        const record = row as Record<string, unknown>;
        const itemId = text(field(record, "itemId"));
        if (itemId == null) return [];
        const sites = field(record, "sites");
        return [
          {
            itemId,
            kind: text(record.kind) ?? "item",
            label: text(record.label) ?? "",
            sites: Array.isArray(sites)
              ? sites.filter((site): site is string => typeof site === "string")
              : [],
            brand: text(record.brand),
            last4: text(field(record, "last4")),
            expiryMonth: num(field(record, "expiryMonth")),
            expiryYear: num(field(record, "expiryYear")),
            nameOnCard: text(field(record, "nameOnCard")),
          },
        ];
      }),
    };
  }

  async createRequest(input: {
    kind: VaultRequestKind;
    site?: string;
    itemId?: string;
    paymentApprovalId?: string;
    origin?: string;
  }): Promise<
    VaultResult<{ requestId: string; url: string; expiresAt: number | null }>
  > {
    const result = await this.call("_createAbacusbotVaultRequest", "POST", {
      kind: input.kind,
      ...(input.site != null ? { site: input.site } : {}),
      ...(input.itemId != null ? { itemId: input.itemId } : {}),
      ...(input.paymentApprovalId != null
        ? { paymentApprovalId: input.paymentApprovalId }
        : {}),
      ...(input.origin != null ? { origin: input.origin } : {}),
    });
    if (result.ok === false) return result;
    const record = (result.value ?? {}) as Record<string, unknown>;
    const requestId = text(field(record, "requestId"));
    const url = text(record.url);
    if (requestId == null || url == null || !url.startsWith("https://"))
      return this.malformed("_createAbacusbotVaultRequest");
    return {
      ok: true,
      value: { requestId, url, expiresAt: num(field(record, "expiresAt")) },
    };
  }

  async requestStatus(requestId: string): Promise<
    VaultResult<{
      status: VaultRequestStatus;
      itemId: string | null;
      /** A saved login's page approves the one sign-in that follows. */
      signinApprovalId: string | null;
    }>
  > {
    const result = await this.call("_getAbacusbotVaultRequestStatus", "GET", {
      requestId,
    });
    if (result.ok === false) return result;
    const record = (result.value ?? {}) as Record<string, unknown>;
    const status = record.status;
    if (
      status !== "pending" &&
      status !== "completed" &&
      status !== "failed" &&
      status !== "expired"
    )
      return this.malformed("_getAbacusbotVaultRequestStatus");
    return {
      ok: true,
      value: {
        status,
        itemId: text(field(record, "itemId")),
        signinApprovalId: text(field(record, "signinApprovalId")),
      },
    };
  }

  async createPaymentApproval(input: {
    itemId: string;
    merchant: string;
    amount: string;
    currency: string;
    origin: string;
    cvvRequired: boolean;
  }): Promise<
    VaultResult<{
      paymentApprovalId: string;
      url: string;
      amount: string;
      currency: string;
      site: string;
      expiresAt: number | null;
    }>
  > {
    const result = await this.call("_createAbacusbotPaymentApproval", "POST", {
      itemId: input.itemId,
      merchant: input.merchant,
      amount: input.amount,
      currency: input.currency,
      origin: input.origin,
      cvvRequired: input.cvvRequired,
    });
    if (result.ok === false) return result;
    const record = (result.value ?? {}) as Record<string, unknown>;
    const paymentApprovalId = text(field(record, "paymentApprovalId"));
    const url = text(record.url);
    // The site is what a fill is checked against; an approval without one is no use.
    const site = text(record.site);
    if (
      paymentApprovalId == null ||
      url == null ||
      !url.startsWith("https://") ||
      site == null
    )
      return this.malformed("_createAbacusbotPaymentApproval");
    return {
      ok: true,
      value: {
        paymentApprovalId,
        url,
        // The amount as the server bound it (normalized), which is what a fill must name.
        amount: text(record.amount) ?? input.amount,
        currency: text(record.currency) ?? input.currency,
        site,
        expiresAt: num(field(record, "expiresAt")),
      },
    };
  }

  /** The approval's status; `expired` when the platform no longer knows it. */
  async paymentApprovalStatus(
    paymentApprovalId: string
  ): Promise<VaultResult<{ status: "pending" | "approved" | "expired" }>> {
    const result = await this.call("_getAbacusbotPaymentApproval", "GET", {
      paymentApprovalId,
    });
    if (result.ok === false)
      return result.notFound
        ? { ok: true, value: { status: "expired" } }
        : result;
    const status = ((result.value ?? {}) as Record<string, unknown>).status;
    return {
      ok: true,
      value: {
        status:
          status === "approved"
            ? "approved"
            : status === "pending"
              ? "pending"
              : "expired",
      },
    };
  }

  /** A pending sign-in approval for a saved login, and the page the user allows it on. */
  async createSigninApproval(input: { itemId: string }): Promise<
    VaultResult<{
      signinApprovalId: string;
      url: string;
      site: string;
      expiresAt: number | null;
    }>
  > {
    const result = await this.call(
      "_createAbacusbotSigninApproval",
      "POST",
      { itemId: input.itemId },
      SIGNIN_UNSUPPORTED
    );
    if (result.ok === false) return result;
    const record = (result.value ?? {}) as Record<string, unknown>;
    const signinApprovalId = text(field(record, "signinApprovalId"));
    const url = text(record.url);
    // The site is what a fill is checked against; an approval without one is no use.
    const site = text(record.site);
    if (
      signinApprovalId == null ||
      url == null ||
      !url.startsWith("https://") ||
      site == null
    )
      return this.malformed("_createAbacusbotSigninApproval");
    return {
      ok: true,
      value: {
        signinApprovalId,
        url,
        site,
        expiresAt: num(field(record, "expiresAt")),
      },
    };
  }

  /**
   * The sign-in approval's status (`expired` for anything the platform does
   * not call live), with the site it is bound to and, once approved, until
   * when (epoch seconds).
   */
  async signinApprovalStatus(signinApprovalId: string): Promise<
    VaultResult<{
      status: "pending" | "approved" | "denied" | "expired";
      site: string | null;
      expiresAt: number | null;
    }>
  > {
    const result = await this.call(
      "_getAbacusbotSigninApproval",
      "GET",
      { signinApprovalId },
      SIGNIN_UNSUPPORTED
    );
    if (result.ok === false) return result;
    const record = (result.value ?? {}) as Record<string, unknown>;
    const status = record.status;
    return {
      ok: true,
      value: {
        status:
          status === "approved" || status === "pending" || status === "denied"
            ? status
            : "expired",
        site: text(record.site),
        expiresAt: num(field(record, "expiresAt")),
      },
    };
  }

  /**
   * One field's value, for the caller to type at once and drop. `origin` is
   * the live page's; the server checks it against the item.
   */
  async fill(input: {
    itemId: string;
    field: VaultField;
    origin: string;
    paymentApprovalId?: string;
    signinApprovalId?: string;
    amount?: string;
    currency?: string;
    frameOrigin?: string;
  }): Promise<VaultResult<string>> {
    const result = await this.call("_fillAbacusbotVaultField", "POST", {
      itemId: input.itemId,
      field: input.field,
      origin: input.origin,
      ...(input.paymentApprovalId != null
        ? { paymentApprovalId: input.paymentApprovalId }
        : {}),
      ...(input.signinApprovalId != null
        ? { signinApprovalId: input.signinApprovalId }
        : {}),
      ...(input.amount != null ? { amount: input.amount } : {}),
      ...(input.currency != null ? { currency: input.currency } : {}),
      ...(input.frameOrigin != null ? { frameOrigin: input.frameOrigin } : {}),
    });
    if (result.ok === false) return result;
    const value = ((result.value ?? {}) as Record<string, unknown>).value;
    if (typeof value !== "string" || value.length === 0)
      return this.malformed("_fillAbacusbotVaultField");
    return { ok: true, value };
  }

  private apiKey(): string {
    return (this.deps.apiKey ?? (() => credentialFor("ABACUS_API_KEY")))();
  }

  private log(line: string): void {
    (this.deps.log ?? console.warn)(line);
  }

  private malformed<T>(method: string): VaultResult<T> {
    this.log(`[vault] ${method}: unexpected response shape`);
    return { ok: false, unavailable: false, error: GENERIC_FAILURE };
  }

  /**
   * One call. The bodies stay in this function: only the method and status
   * are logged. `missingRoute` is what a newer endpoint's absence on an older
   * server means, said instead of switching the whole vault off.
   */
  private async call(
    method: string,
    httpMethod: "GET" | "POST",
    body: Record<string, unknown> = {},
    missingRoute?: string
  ): Promise<
    | { ok: true; value: unknown }
    | { ok: false; unavailable: boolean; error: string; notFound?: boolean }
  > {
    const key = this.apiKey();
    if (key.length === 0)
      return { ok: false, unavailable: true, error: VAULT_UNAVAILABLE };
    let status = 0;
    let payload: Record<string, unknown> | null = null;
    try {
      const url = new URL(
        `/api/v1/${method}`,
        (this.deps.host ?? abacusAppHost)()
      );
      if (httpMethod === "GET")
        for (const [name, value] of Object.entries(body))
          url.searchParams.set(name, String(value));
      const response = await this.fetchFn(url, {
        method: httpMethod,
        headers: {
          apikey: key,
          // Cloudflare 403s Node's default agent. See abacusUserAgent.
          "user-agent": (this.deps.userAgent ?? abacusUserAgent)(),
          ...(httpMethod === "POST"
            ? { "content-type": "application/json" }
            : {}),
        },
        ...(httpMethod === "POST" ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      status = response.status;
      const parsed: unknown = await response.json().catch(() => null);
      payload =
        parsed != null && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)
          : null;
      if (response.ok && payload?.success === true) {
        this.unavailableUntil = 0;
        return { ok: true, value: payload.result ?? null };
      }
    } catch {
      this.log(`[vault] ${method}: request failed`);
      return { ok: false, unavailable: false, error: GENERIC_FAILURE };
    }
    this.log(`[vault] ${method}: refused (HTTP ${status})`);
    const reason = text(payload?.error);
    // An older server answers an endpoint it lacks with a bare 404 or a
    // Generic404Error ("Action ... not found"); a missing item is a DataNotFoundError.
    if (
      missingRoute != null &&
      status === 404 &&
      (reason == null || text(payload?.errorType) === "Generic404Error")
    )
      return { ok: false, unavailable: false, error: missingRoute };
    // A missing route (an older server) is a vault that is not there.
    if (
      (status === 404 && reason == null) ||
      (reason != null && UNAVAILABLE_RE.test(reason))
    ) {
      this.unavailableUntil = Date.now() + UNAVAILABLE_FOR_MS;
      return { ok: false, unavailable: true, error: VAULT_UNAVAILABLE };
    }
    return {
      ok: false,
      unavailable: false,
      error:
        reason != null && reason.length <= MAX_REASON_CHARS
          ? reason
          : GENERIC_FAILURE,
      ...(status === 404 ||
      text(payload?.errorType)?.includes("NotFound") === true
        ? { notFound: true }
        : {}),
    };
  }
}
