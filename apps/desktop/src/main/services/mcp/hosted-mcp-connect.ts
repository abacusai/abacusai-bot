/**
 * Connecting MCP servers on a host the user reaches through a browser (the
 * web host). Every surface opens `<base>/mcp/connect/<name>`, which goes
 * straight to the provider: the GET runs discovery, registration and PKCE
 * for the entry the connector would get, holds the sign-in in memory, and
 * redirects the tab to the provider's consent screen. Nothing is installed
 * until the provider's redirect lands at `<base>/mcp/callback` and its code is
 * exchanged; only then is the entry added (never touching one already there).
 * The PKCE verifier never leaves the host. A server that asks for no sign-in
 * holds no credentials, so it is installed on the GET. Admission is the
 * proxy's signed proof (checked by the HTTP server), the owner identity,
 * top-level navigation fetch metadata, and the OAuth state for the callback
 * (spec 08, D8 exception).
 */
import crypto from "crypto";
import type { IncomingHttpHeaders } from "http";

import type { McpServerEntry } from "@abacus-ai/contract/contracts";

import type { McpConnectPlan } from "../connectors/connector-flow-service";
import {
  exchangeCode,
  forgetMcpTokens,
  oauthLog,
  prepareSignIn,
  type PreparedSignIn,
} from "./mcp-oauth-service";

/** How long a sign-in waits for the provider's redirect. */
const PENDING_TTL_MS = 30 * 60_000;

/** One `/mcp/*` request, as the HTTP server read it. */
export interface HostedRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
}

/** What a `/mcp/*` route answers; the HTTP server only writes it out. */
export type HostedResponse =
  | { kind: "redirect"; location: string }
  | { kind: "page"; status: 200 | 400; html: string }
  | { kind: "refused" }
  | { kind: "missing" };

type ReadySignIn = Extract<PreparedSignIn, { kind: "ready" }>;

/** When a connect started; a revoke of its connector after that voids it. */
interface Ticket {
  seq: number;
  at: number;
}

interface PendingSignIn extends Pick<
  ReadySignIn,
  "state" | "verifier" | "redirectUri" | "metadata" | "client"
> {
  name: string;
  /** What the page calls it ("Notion"). */
  label: string;
  serverUrl: string;
  /** What the connector is installed as once the sign-in lands. */
  entry: McpServerEntry;
  /** The app path the tab returns to, already checked; null for the page. */
  returnTo: string | null;
  ticket: Ticket;
}

/**
 * Connects in flight, in memory only. A connect takes a ticket when it
 * starts; a revoke of its connector after that voids it, through discovery,
 * the wait for the provider and the code exchange alike, and nothing lives
 * past 30 minutes. A sign-in waiting for the provider's redirect is one per
 * owner and connector (a newer one replaces it), taken once and only by its
 * owner.
 */
class PendingSignIns {
  private readonly byOwner = new Map<string, Map<string, PendingSignIn>>();
  /** The last revoke per connector; older than any live ticket once pruned. */
  private readonly revoked = new Map<string, Ticket>();
  private revokedAll = 0;
  private seq = 0;

  constructor(private readonly now: () => number) {}

  ticket(): Ticket {
    return { seq: ++this.seq, at: this.now() };
  }

  /** Whether a connect started with `ticket` may still complete. */
  current(name: string, ticket: Ticket): boolean {
    return (
      this.now() - ticket.at < PENDING_TTL_MS &&
      ticket.seq > this.revokedAll &&
      ticket.seq > (this.revoked.get(name)?.seq ?? 0)
    );
  }

  hold(owner: string, flow: PendingSignIn): void {
    this.prune();
    let names = this.byOwner.get(owner);
    if (names == null) this.byOwner.set(owner, (names = new Map()));
    names.set(flow.name, flow);
  }

  /** The owner's live sign-in with this state, removed so it completes once. */
  take(owner: string, state: string | null): PendingSignIn | undefined {
    this.prune();
    const names = this.byOwner.get(owner);
    if (state == null || names == null) return undefined;
    for (const [name, flow] of names)
      if (safeEqual(flow.state, state)) {
        names.delete(name);
        return flow;
      }
    return undefined;
  }

  /** Voids `name`'s connects, or every one, wherever they are. */
  revoke(name?: string): void {
    const ticket = this.ticket();
    if (name == null) {
      this.revokedAll = ticket.seq;
      this.byOwner.clear();
      return;
    }
    this.revoked.set(name, ticket);
    for (const names of this.byOwner.values()) names.delete(name);
  }

  /** Expired sign-ins go, and revokes no live ticket can predate. */
  private prune(): void {
    for (const [owner, names] of this.byOwner) {
      for (const [name, flow] of names)
        if (!this.current(name, flow.ticket)) names.delete(name);
      if (names.size === 0) this.byOwner.delete(owner);
    }
    const now = this.now();
    for (const [name, revoke] of this.revoked)
      if (now - revoke.at >= PENDING_TTL_MS) this.revoked.delete(name);
  }
}

const CONNECT_ROUTE = /^\/mcp\/connect\/([^/]{1,256})$/;

export class HostedMcpConnect {
  private readonly pending: PendingSignIns;

  constructor(
    private readonly options: {
      /** The host's public base, absolute, no trailing slash. */
      base: string;
      /** What connecting `name` takes, decided without installing anything. */
      plan: (name: string) => McpConnectPlan;
      /** Adds `name`'s entry unless one is there; false when it could not. */
      install: (name: string, entry: McpServerEntry) => boolean;
      /** `name` is installed and needs nothing more. */
      connected: (name: string) => void;
      /** A connect the user started did not finish. */
      failed: (name: string) => void;
      now?: () => number;
    }
  ) {
    this.pending = new PendingSignIns(options.now ?? Date.now);
  }

  /** The route a browser opens to connect `name`; also the link sent in chat. */
  connectUrl(name: string): string {
    return `${this.options.base}/mcp/connect/${encodeURIComponent(name)}`;
  }

  /** Drops the pending sign-in for `name`, or for every connector. */
  revoke(name?: string): void {
    this.pending.revoke(name);
  }

  /**
   * Every `/mcp/*` request, once the HTTP server checked the proxy's proof.
   * `owner` is the host's; the proxy's header must match it. Every route is
   * a top-level navigation: never a fetch, an image or a frame.
   */
  async route(request: HostedRequest, owner: string): Promise<HostedResponse> {
    const { headers } = request;
    // Sec-Fetch-Site is deliberately not checked: chat and WhatsApp links
    // arrive cross-site. That is safe because the GET never installs a
    // connector that signs in, a no-sign-in registry connector carries no
    // credentials, an existing entry is never touched, and the worst a
    // forged navigation does is replace an in-flight sign-in, which the
    // user retries.
    if (
      !sameOwner(headers["x-abacus-user-id"], owner) ||
      headers["sec-fetch-dest"] !== "document" ||
      headers["sec-fetch-mode"] !== "navigate"
    )
      return { kind: "refused" };
    if (request.method !== "GET") return { kind: "missing" };
    if (request.pathname === "/mcp/callback")
      return this.callback(request.query, owner);
    const name = connectName(request.pathname);
    if (name == null) return { kind: "missing" };
    return this.start(owner, name, returnPath(request.query.get("return")));
  }

  /** Straight to the provider's consent; nothing persists but a no-sign-in install. */
  private async start(
    owner: string,
    name: string,
    returnTo: string | null
  ): Promise<HostedResponse> {
    const plan = this.options.plan(name);
    if (plan.kind === "missing") return { kind: "missing" };
    if (plan.kind === "needs-fields") {
      this.options.failed(name);
      return needsAppPage(plan.label);
    }
    const { label, entry } = plan;
    const serverUrl = entry.url;
    if (!plan.signsIn || serverUrl == null)
      return this.finish(name, label, entry, returnTo);
    const ticket = this.pending.ticket();
    try {
      const prepared = await prepareSignIn({
        serverUrl,
        redirectUri: `${this.options.base}/mcp/callback`,
        ...(typeof entry.oauth === "object" ? { oauth: entry.oauth } : {}),
      });
      // Cancelled while discovery ran: nothing may complete it.
      if (!this.pending.current(name, ticket)) {
        oauthLog(serverUrl, "hosted sign-in cancelled before it started");
        return this.fail(name, label);
      }
      if (prepared.kind === "open")
        return this.finish(name, label, entry, returnTo);
      const { state, verifier, redirectUri, metadata, client } = prepared;
      this.pending.hold(owner, {
        name,
        label,
        serverUrl,
        entry,
        returnTo,
        state,
        verifier,
        redirectUri,
        metadata,
        client,
        ticket,
      });
      oauthLog(serverUrl, "hosted sign-in started");
      return { kind: "redirect", location: prepared.location };
    } catch (error) {
      oauthLog(
        serverUrl,
        `hosted sign-in could not start: ${errorText(error)}`
      );
      return this.fail(name, label);
    }
  }

  /** The provider's redirect: one exchange per state, for its owner, then the install. */
  private async callback(
    params: URLSearchParams,
    owner: string
  ): Promise<HostedResponse> {
    const flow = this.pending.take(owner, params.get("state"));
    if (flow == null) return failedPage(undefined);
    const code = params.get("code");
    if (params.get("error") != null || code == null || code === "") {
      oauthLog(flow.serverUrl, "hosted sign-in refused or returned no code");
      return this.fail(flow.name, flow.label);
    }
    try {
      const result = await exchangeCode({
        serverUrl: flow.serverUrl,
        metadata: flow.metadata,
        client: flow.client,
        code,
        redirectUri: flow.redirectUri,
        verifier: flow.verifier,
      });
      oauthLog(
        flow.serverUrl,
        result.ok ? "signed in: tokens saved" : `failed: ${result.error}`
      );
      if (!result.ok) return this.fail(flow.name, flow.label);
    } catch (error) {
      oauthLog(flow.serverUrl, `failed: ${errorText(error)}`);
      return this.fail(flow.name, flow.label);
    }
    // The tokens are saved; they stand only with the connector installed.
    const kept =
      this.pending.current(flow.name, flow.ticket) &&
      this.options.install(flow.name, flow.entry);
    if (!kept) {
      forgetMcpTokens(flow.serverUrl);
      oauthLog(
        flow.serverUrl,
        "hosted sign-in cancelled or not installed: tokens dropped"
      );
      return this.fail(flow.name, flow.label);
    }
    return this.connectedAnswer(flow.name, flow.label, flow.returnTo);
  }

  /** Installs `name` when absent, announces it, and sends the tab on. */
  private finish(
    name: string,
    label: string,
    entry: McpServerEntry,
    returnTo: string | null
  ): HostedResponse {
    if (!this.options.install(name, entry)) return this.fail(name, label);
    return this.connectedAnswer(name, label, returnTo);
  }

  /** Announces `name` connected and sends the tab on. */
  private connectedAnswer(
    name: string,
    label: string,
    returnTo: string | null
  ): HostedResponse {
    this.options.connected(name);
    return returnTo != null
      ? { kind: "redirect", location: withConnected(returnTo, name) }
      : connectedPage(label);
  }

  private fail(name: string, label: string): HostedResponse {
    this.options.failed(name);
    return failedPage(label);
  }
}

/** The connector named by a connect route, or null. */
const connectName = (pathname: string): string | null => {
  const match = CONNECT_ROUTE.exec(pathname);
  if (match == null) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
};

/** Resolves paths only; never a real origin. */
const PATH_BASE = "http://host.invalid";

/**
 * The app path a connect returns to: same origin and under `/bot/`, printable
 * ASCII with no `//` or backslash. Anything else is ignored (null).
 */
const returnPath = (raw: string | null): string | null => {
  if (
    raw == null ||
    !raw.startsWith("/bot/") ||
    raw.includes("//") ||
    raw.includes("\\") ||
    /[^ -~]/.test(raw)
  )
    return null;
  const url = new URL(raw, PATH_BASE);
  return url.origin === PATH_BASE && url.pathname.startsWith("/bot/")
    ? `${url.pathname}${url.search}`
    : null;
};

/** The checked return path with `connected=<name>` set on its query. */
const withConnected = (path: string, name: string): string => {
  const url = new URL(path, PATH_BASE);
  url.searchParams.set("connected", name);
  return `${url.pathname}${url.search}`;
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const safeEqual = (a: string, b: string): boolean =>
  a.length === b.length &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The proxy's identity header against the host's owner, in constant time. */
const sameOwner = (header: unknown, owner: string): boolean =>
  typeof header === "string" &&
  Buffer.byteLength(header) === Buffer.byteLength(owner) &&
  crypto.timingSafeEqual(Buffer.from(header), Buffer.from(owner));

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ] ?? ch
  );

/** `label` comes from the host's registry or config, never the provider. No script, no form. */
const page = (status: 200 | 400, body: string): HostedResponse => ({
  kind: "page",
  status,
  html: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>AbacusAI Bot</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box;background:#fff;color:#111;text-align:center}p{color:#555}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}p{color:#aaa}}</style>
<main>${body}</main>`,
});

const connectedPage = (label: string): HostedResponse =>
  page(
    200,
    `<h2>${escapeHtml(label)} is connected.</h2><p>You can go back to AbacusAI Bot or WhatsApp now.</p>`
  );

const needsAppPage = (label: string): HostedResponse =>
  page(
    400,
    `<h2>${escapeHtml(label)} needs a few details first.</h2><p>Open AbacusAI Bot to connect it.</p>`
  );

const failedPage = (label: string | undefined): HostedResponse =>
  page(
    400,
    `<h2>Sign-in did not finish.</h2><p>Close this tab and try connecting${label != null ? ` ${escapeHtml(label)}` : ""} again from AbacusAI Bot.</p>`
  );
