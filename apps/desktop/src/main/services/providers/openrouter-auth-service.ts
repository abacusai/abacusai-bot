import crypto from "crypto";
import http from "http";
import type { AddressInfo } from "net";

import { shell } from "electron";

/**
 * "Connect OpenRouter" — OAuth PKCE instead of copy-pasting a key. The flow
 * needs no registered client id and accepts a loopback callback on any port,
 * so the app opens the browser, listens on 127.0.0.1, and exchanges the code
 * for a key. That key is the same kind as a pasted one and lands in
 * `saveApiKey`.
 */

const AUTH_URL = "https://openrouter.ai/auth";
const KEY_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";

/**
 * How long the loopback listener stays open: long enough for someone to make
 * an OpenRouter account and come back. A cancel is offered wherever the hop
 * is, so a generous budget costs the user nothing.
 */
const AUTH_TIMEOUT_MS = 20 * 60 * 1000;

/** Says what to do next, because the usual cause is fixed in the browser. */
const OPENROUTER_TIMEOUT =
  "Timed out waiting for OpenRouter sign-in. Sign in at openrouter.ai, then press Connect again.";

/**
 * The key exchange, once the code is back: bounds waiting on OpenRouter so a
 * request that never answers cannot leave the dialog on "Connecting…".
 */
const EXCHANGE_TIMEOUT_MS = 30 * 1000;

export type OpenRouterAuthResult =
  | { ok: true; key: string }
  | { ok: false; error: string; cancelled?: boolean };

/** base64url(sha256(verifier)), which is what `code_challenge_method=S256` means. */
const codeChallengeFor = (verifier: string): string =>
  crypto.createHash("sha256").update(verifier).digest("base64url");

/**
 * One in-flight attempt at a time: a second click would leave a listener bound
 * with a verifier that no longer matches the browser window.
 */
let inFlight: { close: () => void } | null = null;

export const cancelOpenRouterAuth = (): void => {
  inFlight?.close();
  inFlight = null;
};

export const startOpenRouterAuth = async (): Promise<OpenRouterAuthResult> => {
  cancelOpenRouterAuth();

  const verifier = crypto.randomBytes(32).toString("base64url");
  // A random path segment stands in for an OAuth `state`: only a redirect that
  // knows it is accepted, so another process on this machine cannot drive our
  // callback by guessing the port.
  const callbackPath = `/${crypto.randomBytes(16).toString("hex")}`;

  return new Promise<OpenRouterAuthResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (url.pathname !== callbackPath) {
        res.writeHead(404).end();
        return;
      }

      const code = url.searchParams.get("code");
      // Answer the browser before the exchange: the user is looking at this
      // tab, and it should say "done" without waiting on another round trip.
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(RESPONSE_PAGE);

      if (code == null || code.length === 0) {
        finish({
          ok: false,
          error: "OpenRouter did not return an authorization code.",
        });
        return;
      }

      void exchange(code, verifier).then(finish);
    });

    const finish = (result: OpenRouterAuthResult): void => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      server.close();
      if (inFlight?.close === close) inFlight = null;
      resolve(result);
    };

    const close = (): void => {
      finish({ ok: false, error: "Sign-in was cancelled.", cancelled: true });
    };

    server.on("error", (error) => {
      finish({ ok: false, error: error.message });
    });

    // Registered synchronously, before listen's callback: a second click that
    // lands in the window between listen() and its callback must still cancel
    // this attempt, or its loopback server leaks for the session.
    inFlight = { close };

    // Port 0 = let the OS pick a free one. Bound to loopback only, so nothing
    // off this machine can reach the callback.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;

      timer = setTimeout(() => {
        finish({
          ok: false,
          error: OPENROUTER_TIMEOUT,
        });
      }, AUTH_TIMEOUT_MS);

      const authUrl = new URL(AUTH_URL);
      authUrl.searchParams.set(
        "callback_url",
        `http://127.0.0.1:${port}${callbackPath}`
      );
      authUrl.searchParams.set("code_challenge", codeChallengeFor(verifier));
      authUrl.searchParams.set("code_challenge_method", "S256");

      void shell.openExternal(authUrl.toString()).catch((error: unknown) => {
        finish({
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "Could not open the browser.",
        });
      });
    });
  });
};

const exchange = async (
  code: string,
  verifier: string
): Promise<OpenRouterAuthResult> => {
  try {
    const response = await fetch(KEY_EXCHANGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: "S256",
      }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        ok: false,
        error: `OpenRouter rejected the sign-in (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
      };
    }

    const payload = (await response.json().catch(() => null)) as {
      key?: unknown;
    } | null;
    const key = typeof payload?.key === "string" ? payload.key.trim() : "";

    if (key.length === 0)
      return { ok: false, error: "OpenRouter returned no key." };

    return { ok: true, key };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Could not reach OpenRouter.",
    };
  }
};

/** What the browser tab shows after the redirect; a raw "OK" reads like a failure. */
const RESPONSE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AbacusAIBot connected</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.5 ui-sans-serif, -apple-system, system-ui, sans-serif;
    background: #fff; color: #111;
  }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } }
  .card { text-align: center; padding: 2rem; }
  h1 { font-size: 1.05rem; margin: 0 0 .35rem; }
  p { margin: 0; opacity: .65; font-size: .875rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>AbacusAIBot is connected</h1>
    <p>You can close this tab and go back to the app.</p>
  </div>
</body>
</html>`;
