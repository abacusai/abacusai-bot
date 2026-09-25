import crypto from "crypto";
import fs from "fs";
import http from "http";
import type { AddressInfo } from "net";
import path from "path";

import {
  MCP_OAUTH_CALLBACK_PORT,
  mcpOAuthRedirectUri,
  type McpOAuthEntry,
} from "#shared/contracts";

import { abacusBotHome } from "../../paths";

/**
 * Signing in to an MCP server: the interactive half of MCP OAuth (RFC 9728,
 * 8414, 7591, 7636, 8252), from the 401 through discovery and registration to
 * a PKCE flow and loopback redirect. Tokens land in `mcp-auth.json`, which the
 * agent reads headlessly (packages/agent/src/mcp/auth.ts); the two must stay
 * in step and cannot import each other. Token refresh and UI are not here.
 */

/** Long enough to log in and click through consent; short enough that an abandoned attempt frees its port. */
const SIGN_IN_TIMEOUT_MS = 20 * 60 * 1000;

const DISCOVERY_TIMEOUT_MS = 15_000;

/** See the contract for why this is fixed; `bindCallbackServer` handles a clash. */
const CALLBACK_PORT = MCP_OAUTH_CALLBACK_PORT;

// The shared token file. Mirrors packages/agent/src/mcp/auth.ts exactly.

interface McpTokenRecord {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

interface McpAuthFile {
  servers?: Record<string, McpTokenRecord>;
  /** DCR results keyed by issuer, plus the redirect URI they were registered with. */
  clients?: Record<
    string,
    { clientId: string; clientSecret?: string; redirectUri?: string }
  >;
}

const authFilePath = (): string => path.join(abacusBotHome(), "mcp-auth.json");

/** One line per stage, tagged, to the main log. Never a token or a code. */
const oauthLog = (serverUrl: string, line: string): void => {
  console.log(`[mcp-oauth] ${serverUrl}: ${line}`);
};

const readAuthFile = (): McpAuthFile => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(authFilePath(), "utf8"));

    return parsed != null && typeof parsed === "object"
      ? (parsed as McpAuthFile)
      : {};
  } catch {
    return {};
  }
};

const writeAuthFile = (file: McpAuthFile): void => {
  const target = authFilePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Temp file and rename: a crash mid-write must not leave a half-flushed file.
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  try {
    fs.chmodSync(temp, 0o600);
  } catch {
    // Windows and some network filesystems don't do POSIX modes. Not fatal.
  }
  fs.renameSync(temp, target);
};

// Discovery

interface AuthServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
}

const fetchJson = async (
  url: string
): Promise<Record<string, unknown> | null> => {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/**
 * Where the protected-resource metadata lives: `WWW-Authenticate` may say
 * (RFC 9728 §5.1); otherwise the path-aware well-known URL, then the root.
 */
const resourceMetadataCandidates = (
  serverUrl: string,
  wwwAuthenticate: string | null
): string[] => {
  const candidates: string[] = [];
  const fromHeader = wwwAuthenticate?.match(/resource_metadata="([^"]+)"/)?.[1];

  if (fromHeader != null) candidates.push(fromHeader);

  const url = new URL(serverUrl);

  if (url.pathname !== "/" && url.pathname.length > 0) {
    candidates.push(
      `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`
    );
  }
  candidates.push(`${url.origin}/.well-known/oauth-protected-resource`);

  return candidates;
};

/**
 * Probe the server and find who authorizes access to it. Falls back to the
 * server's own origin, the pre-RFC-9728 arrangement some servers still ship.
 */
const discoverAuthorizationServer = async (
  serverUrl: string
): Promise<{ issuer: string; scopes?: string[] }> => {
  let wwwAuthenticate: string | null = null;

  try {
    const probe = await fetch(serverUrl, {
      method: "POST",
      // Same Accept as the real transport: a streamable-HTTP server 406es a
      // client that will not take SSE, which would read as "no challenge".
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "abacusai-bot", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });

    if (probe.ok || probe.status !== 401) {
      // Not a 401: the server is open, or failing in a way OAuth will not fix.
      throw new Error(
        probe.ok || probe.status < 400
          ? "This server did not ask for a sign-in. It may already be accessible."
          : `The server answered HTTP ${probe.status}, not a sign-in challenge.`
      );
    }

    wwwAuthenticate = probe.headers.get("www-authenticate");
  } catch (error) {
    if (error instanceof Error && !error.message.startsWith("fetch"))
      throw error;

    throw new Error(
      `Could not reach the server: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  for (const candidate of resourceMetadataCandidates(
    serverUrl,
    wwwAuthenticate
  )) {
    const metadata = await fetchJson(candidate);
    const issuers = metadata?.authorization_servers;

    if (Array.isArray(issuers) && typeof issuers[0] === "string") {
      const scopes = metadata?.scopes_supported;

      return {
        issuer: issuers[0],
        ...(Array.isArray(scopes)
          ? { scopes: scopes.filter((s): s is string => typeof s === "string") }
          : {}),
      };
    }
  }

  return { issuer: new URL(serverUrl).origin };
};

/**
 * The authorization server's endpoints: RFC 8414 layouts first, then the
 * OIDC ones, since real providers split evenly between the two.
 */
const discoverAuthServerMetadata = async (
  issuer: string
): Promise<AuthServerMetadata> => {
  const url = new URL(issuer);
  const trimmedPath = url.pathname.replace(/\/$/, "");
  const candidates =
    trimmedPath.length > 0
      ? [
          `${url.origin}/.well-known/oauth-authorization-server${trimmedPath}`,
          `${url.origin}/.well-known/openid-configuration${trimmedPath}`,
          `${url.origin}${trimmedPath}/.well-known/openid-configuration`,
          `${url.origin}/.well-known/oauth-authorization-server`,
        ]
      : [
          `${url.origin}/.well-known/oauth-authorization-server`,
          `${url.origin}/.well-known/openid-configuration`,
        ];

  for (const candidate of candidates) {
    const metadata = (await fetchJson(candidate)) as AuthServerMetadata | null;

    if (
      metadata?.authorization_endpoint != null &&
      metadata.token_endpoint != null
    ) {
      return metadata;
    }
  }

  throw new Error(
    `No OAuth metadata found for ${issuer}. The server may need a manually configured client.`
  );
};

// Client registration

/**
 * A client id, in order of preference: user-configured, already registered
 * (reusable while the same redirect port binds), or a fresh registration.
 */
const obtainClient = async (
  issuer: string,
  metadata: AuthServerMetadata,
  redirectUri: string,
  configured: McpOAuthEntry | undefined
): Promise<{ clientId: string; clientSecret?: string }> => {
  if (configured?.clientId != null && configured.clientId.length > 0) {
    return {
      clientId: configured.clientId,
      ...(configured.clientSecret != null
        ? { clientSecret: configured.clientSecret }
        : {}),
    };
  }

  const stored = readAuthFile().clients?.[issuer];

  if (stored != null && stored.redirectUri === redirectUri) {
    return {
      clientId: stored.clientId,
      ...(stored.clientSecret != null
        ? { clientSecret: stored.clientSecret }
        : {}),
    };
  }

  if (metadata.registration_endpoint == null) {
    throw new Error(
      "This provider does not support automatic client registration; it needs credentials from its own " +
        `developer console. Create an app there with ${redirectUri} as its redirect URL, then open this ` +
        "server\u2019s Edit dialog and fill in the OAuth client id (and secret, if issued) before " +
        "signing in again."
    );
  }

  const response = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "AbacusAI Bot",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Public client: a desktop app cannot keep a secret; PKCE protects it.
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Client registration was refused (HTTP ${response.status}).`
    );
  }

  const registered = (await response.json()) as {
    client_id?: string;
    client_secret?: string;
  };

  if (
    typeof registered.client_id !== "string" ||
    registered.client_id.length === 0
  ) {
    throw new Error("Client registration returned no client id.");
  }

  const file = readAuthFile();
  writeAuthFile({
    ...file,
    clients: {
      ...file.clients,
      [issuer]: {
        clientId: registered.client_id,
        ...(typeof registered.client_secret === "string"
          ? { clientSecret: registered.client_secret }
          : {}),
        redirectUri,
      },
    },
  });

  return {
    clientId: registered.client_id,
    ...(typeof registered.client_secret === "string"
      ? { clientSecret: registered.client_secret }
      : {}),
  };
};

// The flow

/** Flat rather than discriminated: this repo compiles without strictNullChecks,
 *  under which union narrowing cannot be relied on. `error` is set iff `!ok`. */
export interface McpOAuthResult {
  ok: boolean;
  error?: string;
  cancelled?: boolean;
}

export interface McpOAuthOptions {
  /** Pre-registered client details from the server entry, if any. */
  oauth?: McpOAuthEntry;
  /** Opens the authorization URL; injectable so tests run headlessly. */
  openUrl?: (url: string) => Promise<void>;
}

const RESPONSE_PAGE = `<!doctype html><meta charset="utf-8"><title>AbacusAI Bot</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#111;color:#eee">
<div style="text-align:center"><h2>Signed in</h2><p>You can close this tab and return to AbacusAI Bot.</p></div>`;

const errorPage = (
  detail: string
): string => `<!doctype html><meta charset="utf-8"><title>AbacusAI Bot</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#111;color:#eee">
<div style="text-align:center"><h2>Sign-in failed</h2><p>${detail.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch)}</p><p>You can close this tab and try again from AbacusAI Bot.</p></div>`;

/**
 * Whether a discovered authorization endpoint may be opened. It is
 * server-supplied and goes to `shell.openExternal`, which dispatches on the
 * scheme to any protocol handler; only a web URL is legitimate.
 */
export const isHttpAuthorizationEndpoint = (endpoint: unknown): boolean => {
  if (typeof endpoint !== "string") return false;
  try {
    const { protocol } = new URL(endpoint);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

const defaultOpenUrl = async (url: string): Promise<void> => {
  // Lazy so this module loads under plain Node in tests, without electron.
  const { shell } = await import("electron");

  await shell.openExternal(url);
};

/** One attempt at a given port. Resolves the bound port, or rejects. */
const listenOnce = (server: http.Server, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);

    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve((server.address() as AddressInfo).port);
    });
  });

// How long to keep trying the fixed port: `close()` on the previous attempt
// only starts the unbind, and the port comes free a tick or two later.
const BIND_RETRIES = 5;
const BIND_RETRY_DELAY_MS = 100;

/**
 * Bind the callback server, preferring the fixed port. A pre-registered
 * client has its redirect URL pinned, so another port would send the user
 * through a flow the provider is certain to reject; fail here instead. With
 * dynamic registration an ephemeral port still completes.
 */
const bindCallbackServer = async (
  server: http.Server,
  needsFixedPort: boolean
): Promise<number> => {
  for (let attempt = 0; attempt < BIND_RETRIES; attempt += 1) {
    try {
      return await listenOnce(server, CALLBACK_PORT);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;

      await new Promise((resolve) => setTimeout(resolve, BIND_RETRY_DELAY_MS));
    }
  }

  if (needsFixedPort) {
    throw new Error(
      `Port ${CALLBACK_PORT} is in use, and this server signs in with a client registered against ` +
        `${mcpOAuthRedirectUri()} exactly. Close whatever is using that port and try again.`
    );
  }

  return listenOnce(server, 0);
};

/**
 * The sign-in waiting on a redirect, keyed by server URL. At most one is live
 * (see `cancelAllMcpSignIns`); the key lets a cancel button name its server.
 */
const inFlight = new Map<string, () => void>();

/** Abandon the sign-in for one server, if that is the one in flight. */
export const cancelMcpSignIn = (serverUrl: string): void => {
  inFlight.get(serverUrl)?.();
};

/**
 * Clear the field before starting a sign-in: the fixed callback port is a
 * single resource, and a stale attempt would hold it for the whole timeout.
 */
const cancelAllMcpSignIns = (): void => {
  // The spread snapshots the keys: the body deletes from the collection.
  // oxlint-disable-next-line unicorn/no-useless-spread
  for (const cancel of [...inFlight.values()]) cancel();
};

/**
 * Run the whole sign-in for one MCP server URL. Resolves, never rejects. On
 * success the tokens are on disk; the caller reconnects the session.
 */
export const signInToMcpServer = async (
  serverUrl: string,
  options: McpOAuthOptions = {}
): Promise<McpOAuthResult> => {
  cancelAllMcpSignIns();

  try {
    const { issuer, scopes } = await discoverAuthorizationServer(serverUrl);
    const metadata = await discoverAuthServerMetadata(issuer);
    // Each stage to the main log, so "did the callback arrive?" has an answer.
    oauthLog(serverUrl, `authorization server ${issuer}`);

    if (
      metadata.code_challenge_methods_supported != null &&
      !metadata.code_challenge_methods_supported.includes("S256")
    ) {
      // PKCE stands in for a client secret; without S256 the code is
      // interceptable, and the MCP spec makes it mandatory.
      return {
        ok: false,
        error:
          "This authorization server does not support PKCE (S256), which MCP requires.",
      };
    }

    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto
      .createHash("sha256")
      .update(verifier)
      .digest("base64url");
    const state = crypto.randomBytes(16).toString("hex");

    return await new Promise<McpOAuthResult>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const finish = (result: McpOAuthResult): void => {
        if (settled) return;
        settled = true;
        oauthLog(
          serverUrl,
          result.ok
            ? "signed in: tokens saved"
            : `${result.cancelled === true ? "cancelled" : "failed"}: ${result.error}`
        );
        if (timer != null) clearTimeout(timer);
        // Closing a server that never listened is an error, not a no-op.
        try {
          server.close();
        } catch {
          // Never listened, or already closed. Either way there is nothing to release.
        }
        if (inFlight.get(serverUrl) === close) inFlight.delete(serverUrl);
        resolve(result);
      };

      const close = (): void =>
        finish({ ok: false, error: "Sign-in was cancelled.", cancelled: true });

      const server = http.createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");

        if (url.pathname !== "/callback") {
          response.writeHead(404).end();

          return;
        }

        oauthLog(
          serverUrl,
          `callback received (state ${url.searchParams.get("state") === state ? "ok" : "MISMATCH"}` +
            `${url.searchParams.get("error") != null ? `, error=${url.searchParams.get("error")}` : ""}` +
            `${url.searchParams.has("code") ? ", code present" : ", no code"})`
        );

        // The tab must not say "Signed in" over a state mismatch or an error.
        if (url.searchParams.get("state") !== state) {
          // A redirect that does not know our state is not our redirect.
          // Ignored rather than fatal: the real one may still arrive.
          response
            .writeHead(200, { "content-type": "text/html; charset=utf-8" })
            .end(
              errorPage("This response did not match the sign-in in progress.")
            );

          return;
        }

        const oauthError = url.searchParams.get("error");

        if (oauthError != null) {
          const detail =
            url.searchParams.get("error_description") ??
            `The authorization server refused: ${oauthError}`;
          response
            .writeHead(200, { "content-type": "text/html; charset=utf-8" })
            .end(errorPage(detail));
          finish({
            ok: false,
            error: detail,
            cancelled: oauthError === "access_denied",
          });

          return;
        }

        const code = url.searchParams.get("code");

        if (code == null || code.length === 0) {
          response
            .writeHead(200, { "content-type": "text/html; charset=utf-8" })
            .end(errorPage("The authorization server returned no code."));
          finish({
            ok: false,
            error: "The authorization server returned no code.",
          });

          return;
        }

        // Answer the browser before the token exchange so the tab says "done".
        response
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(RESPONSE_PAGE);

        void (async () => {
          try {
            const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
            const client = await clientPromise;
            const body = new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: redirectUri,
              client_id: client.clientId,
              code_verifier: verifier,
            });

            if (client.clientSecret != null)
              body.set("client_secret", client.clientSecret);

            const exchanged = await fetch(metadata.token_endpoint as string, {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
              },
              body: body.toString(),
              signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
            });

            if (!exchanged.ok) {
              finish({
                ok: false,
                error: `The token exchange failed (HTTP ${exchanged.status}).`,
              });

              return;
            }

            const token = (await exchanged.json()) as {
              access_token?: string;
              refresh_token?: string;
              expires_in?: number;
              scope?: string;
            };

            if (
              typeof token.access_token !== "string" ||
              token.access_token.length === 0
            ) {
              finish({
                ok: false,
                error: "The token exchange returned no access token.",
              });

              return;
            }

            const file = readAuthFile();
            writeAuthFile({
              ...file,
              servers: {
                ...file.servers,
                [serverUrl]: {
                  tokenEndpoint: metadata.token_endpoint as string,
                  clientId: client.clientId,
                  ...(client.clientSecret != null
                    ? { clientSecret: client.clientSecret }
                    : {}),
                  accessToken: token.access_token,
                  ...(typeof token.refresh_token === "string"
                    ? { refreshToken: token.refresh_token }
                    : {}),
                  ...(typeof token.expires_in === "number"
                    ? { expiresAt: Date.now() + token.expires_in * 1000 }
                    : {}),
                  ...(typeof token.scope === "string"
                    ? { scope: token.scope }
                    : {}),
                },
              },
            });

            finish({ ok: true });
          } catch (error) {
            finish({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })();
      });

      // Bind before registering: a fallback to an ephemeral port changes the
      // redirect URI that gets registered.
      let clientPromise: Promise<{ clientId: string; clientSecret?: string }>;

      const needsFixedPort = (options.oauth?.clientId ?? "").length > 0;

      void bindCallbackServer(server, needsFixedPort).then(
        (port) => {
          const redirectUri = `http://127.0.0.1:${port}/callback`;

          // From here on an error means the flow broke, not a taken port.
          server.on("error", (error) =>
            finish({ ok: false, error: error.message })
          );

          clientPromise = obtainClient(
            issuer,
            metadata,
            redirectUri,
            options.oauth
          );

          void clientPromise
            .then(async (client) => {
              const endpoint = metadata.authorization_endpoint as string;

              // Thrown so the catch below routes it through finish().
              if (!isHttpAuthorizationEndpoint(endpoint)) {
                throw new Error(
                  `Authorization endpoint is not an http(s) URL: ${endpoint}`
                );
              }
              const authorize = new URL(endpoint);

              authorize.searchParams.set("response_type", "code");
              authorize.searchParams.set("client_id", client.clientId);
              authorize.searchParams.set("redirect_uri", redirectUri);
              authorize.searchParams.set("state", state);
              authorize.searchParams.set("code_challenge", challenge);
              authorize.searchParams.set("code_challenge_method", "S256");
              // RFC 8707: mint the token for this resource only; old servers
              // ignore the parameter.
              authorize.searchParams.set("resource", serverUrl);

              const scope =
                options.oauth?.scope ??
                (scopes != null && scopes.length > 0
                  ? scopes.join(" ")
                  : undefined);

              if (scope != null) authorize.searchParams.set("scope", scope);

              oauthLog(
                serverUrl,
                `listening on ${redirectUri}; opening ${authorize.origin}${authorize.pathname} in the browser as client ${client.clientId}`
              );
              await (options.openUrl ?? defaultOpenUrl)(authorize.toString());
            })
            .catch((error: unknown) => {
              finish({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
            });
        },
        (error: unknown) => {
          finish({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      );

      timer = setTimeout(
        () =>
          finish({ ok: false, error: "Sign-in timed out.", cancelled: true }),
        SIGN_IN_TIMEOUT_MS
      );
      inFlight.set(serverUrl, close);
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
