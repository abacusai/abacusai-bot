import crypto from "crypto";
import http from "http";
import type { AddressInfo } from "net";

import { app, shell } from "electron";

import { abacusAppHost, abacusUserAgent } from "./abacus-host";

/**
 * "Connect Abacus.AI": a PKCE browser hop, same shape as the OpenRouter flow.
 * The browser only carries a one-time code bound to the S256 challenge; the
 * key is minted server-side on redeem, so a leaked code is useless. Residual:
 * the launch URL is readable on-machine, so a local attacker could graft their
 * own key onto this app; hence the loopback, GET-only, single-shot listener.
 */

const EXCHANGE_PATH = "/api/v1/_exchangeAbacusaibotAuthCode";
const SIGNIN_PATH = "/chatllm/signin";

// How long the loopback listener stays open. Sign-up happens inside this hop
// and takes minutes; Cancel (cancelAbacusAuth) tears it down early.
const AUTH_TIMEOUT_MS = 20 * 60 * 1000;

/** Says what to do next, because the usual cause is fixed in the browser. */
const ABACUS_TIMEOUT =
  "Timed out waiting for Abacus.AI sign-in. Sign in at abacus.ai, then press Connect again.";

export type AbacusAuthResult =
  | { ok: true; key: string }
  | { ok: false; error: string; cancelled?: boolean };

/**
 * What the browser tab is told about the exchange, so a failure that never
 * leaves this machine (the usual case: the app's own request to Abacus.AI
 * fails) is still visible to the user and, via the tab, to Abacus.AI.
 */
type ExchangeOutcome =
  | { state: "pending" }
  | { state: "ok" }
  | { state: "failed"; reason: string };

// After the exchange settles the listener stays up just long enough for the
// tab to read the outcome; the app itself has already been answered.
const RESULT_LINGER_MS = 15_000;

/** base64url(sha256(verifier)), which is what `code_challenge_method=S256` means. */
const codeChallengeFor = (verifier: string): string =>
  crypto.createHash("sha256").update(verifier).digest("base64url");

/** One in-flight attempt at a time, same rationale as the OpenRouter service. */
let inFlight: { close: () => void } | null = null;

export const cancelAbacusAuth = (): void => {
  inFlight?.close();
  inFlight = null;
};

export const startAbacusAuth = async (): Promise<AbacusAuthResult> => {
  cancelAbacusAuth();

  const verifier = crypto.randomBytes(32).toString("base64url");
  // A random path segment stands in for an OAuth `state`, so another local
  // process cannot drive the callback by guessing the port.
  const callbackPath = crypto.randomBytes(16).toString("hex");

  return new Promise<AbacusAuthResult>((resolve) => {
    let settled = false;
    let accepted = false;
    let timer: NodeJS.Timeout | null = null;
    let linger: NodeJS.Timeout | null = null;
    let outcome: ExchangeOutcome = { state: "pending" };
    const abort = new AbortController();

    const closeServer = (): void => {
      if (linger != null) clearTimeout(linger);
      // Drop keep-alive sockets too: server.close() alone waits for the
      // browser's connection to idle out and the port stays held.
      server.closeAllConnections?.();
      server.close();
    };

    const server = http.createServer((req, res) => {
      // GET-only with a 127.0.0.1 Host, so a DNS-rebinding page fails the
      // check; no-store keeps the response out of caches and history.
      const host = (req.headers.host ?? "").toLowerCase();
      if (
        req.method !== "GET" ||
        !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)
      ) {
        res.writeHead(404).end();
        return;
      }

      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      // The tab polls this after the redirect; the path is as unguessable as
      // the callback itself and the body never carries the key.
      if (url.pathname === `/${callbackPath}/result`) {
        res
          .writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-store",
          })
          .end(JSON.stringify(outcome), () => {
            // Close only once the answer has left the socket.
            if (outcome.state !== "pending") closeServer();
          });
        return;
      }

      if (url.pathname !== `/${callbackPath}`) {
        res.writeHead(404).end();
        return;
      }

      // Single-shot: the first request consumes the flow; a replay gets none.
      if (accepted) {
        res.writeHead(409).end();
        return;
      }
      accepted = true;

      const code = url.searchParams.get("code");
      // Answer the browser before the exchange so the tab says "done" at once.
      res
        .writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        })
        .end(responsePage());

      if (code == null || code.length === 0) {
        finish(
          {
            ok: false,
            error: "Abacus.AI did not return an authorization code.",
          },
          "no_code"
        );
        return;
      }

      void exchange(code, verifier, abort.signal).then(({ result, reason }) =>
        finish(result, reason)
      );
    });

    /**
     * Settle the attempt. With a `reason` (or a success) the browser tab is
     * still waiting to hear how the exchange went, so the listener lingers
     * for it; a cancel or timeout has no tab to inform and closes at once.
     */
    const finish = (result: AbacusAuthResult, reason?: string): void => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      abort.abort();
      if (inFlight?.close === close) inFlight = null;
      if (result.ok) outcome = { state: "ok" };
      else if (reason != null) outcome = { state: "failed", reason };
      if (outcome.state === "pending") closeServer();
      else linger = setTimeout(closeServer, RESULT_LINGER_MS);
      resolve(result);
    };

    const close = (): void => {
      finish({ ok: false, error: "Sign-in was cancelled.", cancelled: true });
    };

    server.on("error", (error) => {
      finish({ ok: false, error: error.message });
    });

    // Registered before listen's callback: a second click in that window must
    // still cancel this attempt, or its loopback server leaks.
    inFlight = { close };

    // Port 0 lets the OS pick; loopback-only so nothing off-machine reaches it.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;

      timer = setTimeout(() => {
        finish({
          ok: false,
          error: ABACUS_TIMEOUT,
        });
      }, AUTH_TIMEOUT_MS);

      const authUrl = new URL(SIGNIN_PATH, abacusAppHost());
      authUrl.searchParams.set("isSignUp", "1");
      authUrl.searchParams.set("AbacusAIBot", "1");
      authUrl.searchParams.set("botChallenge", codeChallengeFor(verifier));
      authUrl.searchParams.set("botPort", String(port));
      authUrl.searchParams.set("botPath", callbackPath);

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

// Errors shown to the user are generic: response text arrives over a channel
// a local attacker could influence, so raw detail is logged, not displayed.
const genericFailure: AbacusAuthResult = {
  ok: false,
  error: "Could not complete Abacus.AI sign-in. Please try again.",
};

/** Only a short code ever reaches the tab or the beacon, never response text. */
const reasonCode = (value: string): string =>
  value.replace(/[^A-Za-z0-9_]/g, "").slice(0, 32) || "unknown";

const exchange = async (
  code: string,
  verifier: string,
  signal: AbortSignal
): Promise<{ result: AbacusAuthResult; reason?: string }> => {
  try {
    const response = await fetch(new URL(EXCHANGE_PATH, abacusAppHost()), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": abacusUserAgent(),
      },
      body: JSON.stringify({ authCode: code, verifier }),
      signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(
        `[abacus-auth] exchange rejected: HTTP ${response.status} ${detail.slice(0, 200)}`
      );
      return { result: genericFailure, reason: `http_${response.status}` };
    }

    const payload = (await response.json().catch(() => null)) as {
      success?: unknown;
      result?: { apiKey?: unknown };
      error?: unknown;
    } | null;
    if (payload?.success !== true) {
      if (typeof payload?.error === "string")
        console.warn(`[abacus-auth] exchange failed: ${payload.error}`);
      return { result: genericFailure, reason: "bad_payload" };
    }
    const key =
      typeof payload.result?.apiKey === "string"
        ? payload.result.apiKey.trim()
        : "";

    if (key.length === 0) return { result: genericFailure, reason: "no_key" };

    return { result: { ok: true, key } };
  } catch (error) {
    console.warn(
      `[abacus-auth] exchange error: ${error instanceof Error ? error.message : String(error)}`
    );
    // The error name (TypeError, AbortError, ...) says which class of failure
    // it was without carrying the message, which can name a proxy or a host.
    const name = error instanceof Error ? error.name : "unknown";
    return { result: genericFailure, reason: `fetch_${reasonCode(name)}` };
  }
};

/**
 * The tab shown after the redirect; the plan link is for a new account. Its
 * script polls the listener for the exchange outcome: a failure is shown in
 * the tab (the app can only say "try again") and reported to Abacus.AI as a
 * short code through the browser, which reaches it even when the app's own
 * request could not. Without the script the page is exactly what it was.
 */
const responsePage = (): string => {
  let build = "packaged";
  try {
    if (!app.isPackaged) build = "source";
  } catch {
    // No `app` outside electron (tests).
  }
  // An API path on purpose: the API access log is shipped off the pods (the
  // web one is not), and an unknown method is a logged 404, which is all the
  // beacon needs.
  const beacon = new URL("/api/v1/_abacusaibotSignInResult", abacusAppHost());
  beacon.searchParams.set("build", build);
  return `<!doctype html>
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
  .card { text-align: center; padding: 2rem; max-width: 34rem; }
  h1 { font-size: 1.05rem; margin: 0 0 .35rem; }
  p { margin: 0; opacity: .65; font-size: .875rem; }
  a { color: inherit; }
  code { font-size: .8rem; }
</style>
</head>
<body>
  <div class="card">
    <h1 id="title">Abacus.AI is connected</h1>
    <p id="body">You can close this tab and go back to the app.</p>
    <p id="plan" style="margin-top:.6rem">New account? Your free plan is already active — DeepSeek V4 Flash, Kimi, Qwen, GLM and more coding models are ready to use. <a href="https://apps.abacus.ai/chatllm/" rel="noreferrer">Manage your account</a> or upgrade anytime.</p>
  </div>
  <script>
  (function () {
    var beacon = ${JSON.stringify(beacon.toString())};
    var url = location.pathname + "/result";
    var tries = 0;
    function report(outcome, reason) {
      var img = new Image();
      img.src = beacon + "&outcome=" + encodeURIComponent(outcome) +
        (reason ? "&reason=" + encodeURIComponent(reason) : "");
    }
    function poll() {
      if (tries++ > 40) return;
      fetch(url, { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (o) {
        if (!o || o.state === "pending") { setTimeout(poll, 500); return; }
        if (o.state === "ok") { report("ok"); return; }
        var reason = String(o.reason || "unknown").replace(/[^A-Za-z0-9_]/g, "").slice(0, 32);
        document.getElementById("title").textContent = "Sign-in did not finish in the app";
        document.getElementById("body").innerHTML =
          "Abacus.AI signed you in, but the app could not complete the connection (<code>" + reason + "</code>). " +
          "Go back to the app and try again. If you are running the app from source, the terminal has the full error on a line starting with <code>[abacus-auth]</code>.";
        document.getElementById("plan").hidden = true;
        report("failed", reason);
      }).catch(function () { setTimeout(poll, 500); });
    }
    poll();
  })();
  </script>
</body>
</html>`;
};
