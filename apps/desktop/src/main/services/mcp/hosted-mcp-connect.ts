/**
 * Connecting MCP servers on a host the user reaches through a browser (the
 * web host). Every surface opens `<base>/mcp/connect/<name>`, which only asks:
 * a confirm page whose button posts back with a one-time token. The POST runs
 * the one install-and-sign-in (`ConnectorFlowService.connectMcp`) and sends
 * the tab to the provider, whose redirect lands at `<base>/mcp/callback`. The
 * PKCE verifier never leaves the host. Admission is the proxy's signed proof
 * (checked by the HTTP server), the owner identity, fetch metadata, and that
 * token or the OAuth state (spec 08, D8 exception).
 */
import crypto from "crypto";
import type { IncomingHttpHeaders } from "http";

import type { McpOAuthEntry } from "@abacus-ai/contract/contracts";

import type {
  McpConnectResult,
  McpSignIn,
} from "../connectors/connector-flow-service";
import { exchangeCode, oauthLog, prepareSignIn } from "./mcp-oauth-service";

/** How long the confirm page's button stays good. */
const CONFIRM_TTL_MS = 10 * 60_000;
/** How long a sign-in waits for the provider's redirect. */
const PENDING_TTL_MS = 30 * 60_000;

/** One `/mcp/*` request, as the HTTP server read it. */
export interface HostedRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  /** A POST's form, read only once the route admitted it. */
  readForm: () => Promise<URLSearchParams | { status: 408 | 413 }>;
}

/** What a `/mcp/*` route answers; the HTTP server only writes it out. */
export type HostedResponse =
  | { kind: "redirect"; location: string }
  | { kind: "page"; status: 200 | 400 | 403; html: string }
  | { kind: "refused" }
  | { kind: "missing" }
  /** The form was too large or too slow. */
  | { kind: "bad-body"; status: 408 | 413 };

interface PendingSignIn {
  owner: string;
  name: string;
  /** What the page calls it ("Notion"). */
  label: string;
  serverUrl: string;
  state: string;
  verifier: string;
  redirectUri: string;
  metadata: Parameters<typeof exchangeCode>[0]["metadata"];
  client: { clientId: string; clientSecret?: string };
  /** The confirm-step token this sign-in was begun under. */
  confirmedWith: string;
  expires: number;
}

/** One value per owner and connector: a newer one replaces it. */
class PerConnector<T> {
  private readonly byOwner = new Map<string, Map<string, T>>();

  get(owner: string, name: string): T | undefined {
    return this.byOwner.get(owner)?.get(name);
  }

  set(owner: string, name: string, value: T): void {
    let names = this.byOwner.get(owner);
    if (names == null) this.byOwner.set(owner, (names = new Map()));
    names.set(name, value);
  }

  delete(owner: string, name: string): void {
    this.byOwner.get(owner)?.delete(name);
  }

  /** Every owner's entry for `name`, or every entry. */
  deleteName(name?: string): void {
    if (name == null) this.byOwner.clear();
    else for (const names of this.byOwner.values()) names.delete(name);
  }

  *entries(): IterableIterator<[string, string, T]> {
    for (const [owner, names] of this.byOwner)
      for (const [name, value] of names) yield [owner, name, value];
  }
}

const CONNECT_ROUTE = /^\/mcp\/connect\/([^/]{1,256})$/;

export class HostedMcpConnect {
  /** Confirm-page tokens, minted by the GET, spent by the POST. */
  private readonly tokens = new PerConnector<{
    token: string;
    expires: number;
  }>();
  /** A POST's confirmation, taken by the sign-in it starts. */
  private readonly confirmed = new Map<
    string,
    { owner: string; token: string }
  >();
  private readonly pending = new PerConnector<PendingSignIn>();
  /** Bumped by every revoke, so a sign-in begun before one is dropped. */
  private readonly generations = new PerConnector<number>();
  private readonly now: () => number;

  constructor(
    private readonly options: {
      /** The host's public base, absolute, no trailing slash. */
      base: string;
      /** What a connectable server is called; null when there is none. */
      label: (name: string) => string | null;
      /** The one install-and-sign-in, by registry id or server name. */
      connect: (name: string) => Promise<McpConnectResult>;
      /** A server named `name` now holds a token. */
      signedIn: (name: string) => void;
      /** A connect the user confirmed did not finish. */
      failed: (name: string) => void;
      now?: () => number;
    }
  ) {
    this.now = options.now ?? Date.now;
  }

  /** The route a browser opens to connect `name`; also the link sent in chat. */
  connectUrl(name: string): string {
    return `${this.options.base}/mcp/connect/${encodeURIComponent(name)}`;
  }

  /**
   * Discovery, registration and PKCE, only for a connect the user confirmed
   * on the page; replaces any earlier sign-in for the same connector.
   */
  async begin(input: {
    name: string;
    label: string;
    serverUrl: string;
    oauth?: McpOAuthEntry;
  }): Promise<McpSignIn> {
    const { name, label, serverUrl, oauth } = input;
    const confirmation = this.confirmed.get(name);
    if (confirmation == null) return { kind: "failed", error: "unconfirmed" };
    this.confirmed.delete(name);
    const { owner } = confirmation;
    const generation = this.generationOf(owner, name);
    try {
      const prepared = await prepareSignIn({
        serverUrl,
        redirectUri: `${this.options.base}/mcp/callback`,
        ...(oauth != null ? { oauth } : {}),
      });
      if (prepared.kind === "open") return { kind: "open" };
      // Cancelled while discovery ran: nothing may complete it.
      if (this.generationOf(owner, name) !== generation)
        return { kind: "failed", error: "revoked" };
      this.pending.set(owner, name, {
        owner: confirmation.owner,
        name,
        label,
        serverUrl,
        state: prepared.state,
        verifier: prepared.verifier,
        redirectUri: prepared.redirectUri,
        metadata: prepared.metadata,
        client: prepared.client,
        confirmedWith: confirmation.token,
        expires: this.now() + PENDING_TTL_MS,
      });
      oauthLog(serverUrl, "hosted sign-in started");
      return { kind: "redirect", location: prepared.location };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      oauthLog(serverUrl, `hosted sign-in could not start: ${message}`);
      return { kind: "failed", error: message };
    }
  }

  /**
   * Drops the confirm token and pending sign-in for `name`, or for every
   * connector, including a sign-in still being prepared.
   */
  revoke(name?: string): void {
    this.tokens.deleteName(name);
    this.pending.deleteName(name);
    if (name == null) this.confirmed.clear();
    else this.confirmed.delete(name);
    for (const [owner, entryName, count] of this.generations.entries())
      if (name == null || entryName === name)
        this.generations.set(owner, entryName, count + 1);
  }

  private generationOf(owner: string, name: string): number {
    const current = this.generations.get(owner, name);
    if (current != null) return current;
    this.generations.set(owner, name, 0);
    return 0;
  }

  /**
   * Every `/mcp/*` request, once the HTTP server checked the proxy's proof.
   * `owner` is the host's; the proxy's header must match it. Fetch metadata
   * is required: every route is a top-level page load.
   */
  async route(request: HostedRequest, owner: string): Promise<HostedResponse> {
    if (
      !sameOwner(request.headers["x-abacus-user-id"], owner) ||
      request.headers["sec-fetch-dest"] !== "document"
    )
      return { kind: "refused" };
    this.prune();
    if (request.method === "GET" && request.pathname === "/mcp/callback") {
      const done = await this.complete(request.query, owner);
      if (!done.ok && done.name != null) this.options.failed(done.name);
      return done.ok ? connectedPage(done.label!) : failedPage(done.label);
    }
    const match = CONNECT_ROUTE.exec(request.pathname);
    let name: string | null = null;
    try {
      name = match != null ? decodeURIComponent(match[1]!) : null;
    } catch {
      name = null;
    }
    const label = name != null ? this.options.label(name) : null;
    if (name == null || label == null) return { kind: "missing" };
    if (request.method === "GET") return this.confirmPage(owner, name, label);
    if (request.method === "POST")
      return this.confirmedConnect(request, owner, name, label);
    return { kind: "missing" };
  }

  /** Side-effect free but for one token per connector, replacing the last. */
  private confirmPage(
    owner: string,
    name: string,
    label: string
  ): HostedResponse {
    const token = crypto.randomBytes(24).toString("base64url");
    this.tokens.set(owner, name, {
      token,
      expires: this.now() + CONFIRM_TTL_MS,
    });
    return page(
      200,
      `<h2>Connect ${escapeHtml(label)} to AbacusAI Bot?</h2>
<form method="post" action="${escapeHtml(this.connectUrl(name))}"><input type="hidden" name="token" value="${token}"><button type="submit" style="font:inherit;padding:10px 24px;border-radius:999px;border:0;background:#111;color:#fff;cursor:pointer">Connect</button></form>`
    );
  }

  private async confirmedConnect(
    request: HostedRequest,
    owner: string,
    name: string,
    label: string
  ): Promise<HostedResponse> {
    // A form only ever posts from the confirm page, on this origin.
    if (request.headers["sec-fetch-site"] !== "same-origin")
      return { kind: "refused" };
    const form = await request.readForm();
    if (!(form instanceof URLSearchParams))
      return { kind: "bad-body", status: form.status };
    const minted = this.tokens.get(owner, name);
    const sent = form.get("token") ?? "";
    if (minted == null || !safeEqual(minted.token, sent))
      return page(
        403,
        `<h2>This link has expired.</h2><p>Start connecting ${escapeHtml(label)} again from AbacusAI Bot.</p>`
      );
    this.tokens.delete(owner, name);
    this.confirmed.set(name, { owner, token: minted.token });
    try {
      const result = await this.options.connect(name);
      switch (result.kind) {
        case "sign-in":
          return { kind: "redirect", location: result.location };
        case "connected":
          return connectedPage(result.label);
        case "failed":
          this.options.failed(name);
          return failedPage(result.label);
        case "missing":
          return { kind: "missing" };
      }
    } finally {
      if (this.confirmed.get(name)?.token === minted.token)
        this.confirmed.delete(name);
    }
  }

  /** The provider's redirect: one exchange per state, for its owner, then the flow is gone. */
  private async complete(
    params: URLSearchParams,
    owner: string
  ): Promise<{ ok: boolean; name?: string; label?: string }> {
    const state = params.get("state");
    let flow: PendingSignIn | undefined;
    for (const [flowOwner, , candidate] of this.pending.entries())
      if (
        state != null &&
        flowOwner === owner &&
        safeEqual(candidate.state, state)
      )
        flow = candidate;
    if (flow == null) return { ok: false };
    this.pending.delete(flow.owner, flow.name);
    const failed = { ok: false, name: flow.name, label: flow.label };
    const code = params.get("code");
    if (params.get("error") != null || code == null || code === "") {
      oauthLog(flow.serverUrl, "hosted sign-in refused or returned no code");
      return failed;
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
      if (!result.ok) return failed;
      this.options.signedIn(flow.name);
      return { ok: true, name: flow.name, label: flow.label };
    } catch (error) {
      oauthLog(
        flow.serverUrl,
        `failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return failed;
    }
  }

  private prune(): void {
    const now = this.now();
    for (const store of [this.tokens, this.pending])
      for (const [owner, name, entry] of store.entries())
        if (entry.expires <= now) store.delete(owner, name);
  }
}

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

/** `label` comes from the host's registry or config, never the provider. */
const page = (status: 200 | 400 | 403, body: string): HostedResponse => ({
  kind: "page",
  status,
  html: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AbacusAI Bot</title>
<body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box;background:#fff;color:#111">
<div style="text-align:center">${body}</div>`,
});

const connectedPage = (label: string): HostedResponse =>
  page(
    200,
    `<h2>${escapeHtml(label)} is connected.</h2><p>You can close this tab.</p>`
  );

const failedPage = (label: string | undefined): HostedResponse =>
  page(
    400,
    `<h2>Sign-in did not finish.</h2><p>Close this tab and try connecting${label != null ? ` ${escapeHtml(label)}` : ""} again from AbacusAI Bot.</p>`
  );
