/**
 * Connecting MCP servers on a host the user reaches through a browser (the
 * web host). Every surface opens `<base>/mcp/connect/<name>` in a tab; the host
 * installs and signs in through the one flow (`ConnectorFlowService.connectMcp`),
 * sends the tab to the provider, and takes the provider's redirect at
 * `<base>/mcp/callback`. The PKCE verifier never leaves the host. The routes
 * are admitted on the proxy's owner identity (spec 08, D8 exception).
 */
import crypto from "crypto";

import type { McpOAuthEntry } from "@abacus-ai/contract/contracts";

import type {
  McpConnectResult,
  McpSignIn,
} from "../connectors/connector-flow-service";
import { exchangeCode, oauthLog, prepareSignIn } from "./mcp-oauth-service";

/** How long a sign-in waits for the provider's redirect. */
const PENDING_TTL_MS = 30 * 60_000;
const PENDING_KEPT = 50;

/** What a `/mcp/*` route answers; the HTTP server only writes it out. */
export type HostedResponse =
  | { kind: "redirect"; location: string }
  | { kind: "page"; status: 200 | 400; html: string }
  | { kind: "missing" };

interface PendingSignIn {
  name: string;
  /** What the page calls it ("Notion"). */
  label: string;
  serverUrl: string;
  state: string;
  verifier: string;
  redirectUri: string;
  metadata: Parameters<typeof exchangeCode>[0]["metadata"];
  client: { clientId: string; clientSecret?: string };
  expires: number;
}

const CONNECT_ROUTE = /^\/mcp\/connect\/([^/]{1,256})$/;

export class HostedMcpConnect {
  private readonly pending: PendingSignIn[] = [];
  private readonly now: () => number;

  constructor(
    private readonly options: {
      /** The host's public base, absolute, no trailing slash. */
      base: string;
      /** The one install-and-sign-in, by registry id or server name. */
      connect: (name: string) => Promise<McpConnectResult>;
      /** A server named `name` now holds a token. */
      signedIn: (name: string) => void;
      now?: () => number;
    }
  ) {
    this.now = options.now ?? Date.now;
  }

  /** The route a browser opens to connect `name`; also the link sent in chat. */
  connectUrl(name: string): string {
    return `${this.options.base}/mcp/connect/${encodeURIComponent(name)}`;
  }

  /** Discovery, registration and PKCE now, so the route only redirects. */
  async begin(input: {
    name: string;
    label: string;
    serverUrl: string;
    oauth?: McpOAuthEntry;
  }): Promise<McpSignIn> {
    const { name, label, serverUrl, oauth } = input;
    try {
      const prepared = await prepareSignIn({
        serverUrl,
        redirectUri: `${this.options.base}/mcp/callback`,
        ...(oauth != null ? { oauth } : {}),
      });
      if (prepared.kind === "open") return { kind: "open" };
      this.prune();
      this.pending.push({
        name,
        label,
        serverUrl,
        state: prepared.state,
        verifier: prepared.verifier,
        redirectUri: prepared.redirectUri,
        metadata: prepared.metadata,
        client: prepared.client,
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

  /** `GET /mcp/connect/<name>` and `GET /mcp/callback`. */
  async route(
    pathname: string,
    params: URLSearchParams
  ): Promise<HostedResponse> {
    if (pathname === "/mcp/callback") {
      const done = await this.complete(params);
      return done.ok ? connectedPage(done.label) : failedPage(done.label);
    }
    const match = CONNECT_ROUTE.exec(pathname);
    if (match == null) return { kind: "missing" };
    let name: string;
    try {
      name = decodeURIComponent(match[1]!);
    } catch {
      return { kind: "missing" };
    }
    const result = await this.options.connect(name);
    switch (result.kind) {
      case "sign-in":
        return { kind: "redirect", location: result.location };
      case "connected":
        return connectedPage(result.label);
      case "failed":
        // The reason goes to the log, never onto the page.
        console.warn(`[mcp-connect] ${name}: ${result.error}`);
        return failedPage(result.label);
      case "missing":
        return { kind: "missing" };
    }
  }

  /** The provider's redirect: one exchange per state, then the flow is gone. */
  private async complete(
    params: URLSearchParams
  ): Promise<{ ok: boolean; label?: string }> {
    const state = params.get("state");
    const index = this.pending.findIndex(
      (flow) =>
        state != null &&
        flow.expires > this.now() &&
        safeEqual(flow.state, state)
    );
    if (index < 0) return { ok: false };
    const [flow] = this.pending.splice(index, 1);
    const code = params.get("code");
    if (params.get("error") != null || code == null || code === "") {
      oauthLog(flow.serverUrl, "hosted sign-in refused or returned no code");
      return { ok: false, label: flow.label };
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
      if (result.ok) this.options.signedIn(flow.name);
      return { ok: result.ok, label: flow.label };
    } catch (error) {
      oauthLog(
        flow.serverUrl,
        `failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return { ok: false, label: flow.label };
    }
  }

  private prune(): void {
    const now = this.now();
    // Oldest first: flows are kept in the order they began.
    const live = this.pending
      .filter((flow) => flow.expires > now)
      .slice(-(PENDING_KEPT - 1));
    this.pending.splice(0, this.pending.length, ...live);
  }
}

const safeEqual = (a: string, b: string): boolean =>
  a.length === b.length &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ] ?? ch
  );

/** `label` comes from the host's registry or config, never the provider. */
const page = (status: 200 | 400, body: string): HostedResponse => ({
  kind: "page",
  status,
  html: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AbacusAI Bot</title>
<body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box;background:#111;color:#eee">
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
