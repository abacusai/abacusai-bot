import crypto from "crypto";
import http from "http";
import type { AddressInfo } from "net";

import type { AbacusAuthIntent } from "@abacus-ai/contract/contracts";
import { app, shell } from "electron";

import { bringToFront } from "../../bring-to-front";
import { readSettings } from "../config/settings";
import { reportFunnelStep } from "../debug-sync/funnel-beacon";
import { abacusAppHost, abacusUserAgent } from "./abacus-host";
import { handoffPage } from "./handoff-page";

/**
 * "Connect Abacus.AI": a PKCE browser hop, same shape as the OpenRouter flow.
 * The browser only carries a one-time code bound to the S256 challenge; the
 * key is minted server-side on redeem, so a leaked code is useless. Residual:
 * the launch URL is readable on-machine, so a local attacker could graft their
 * own key onto this app; hence the loopback, GET-only, single-shot listener.
 */

const EXCHANGE_PATH = "/api/v1/_exchangeAbacusaibotAuthCode";
const SIGNIN_PATH = "/chatllm/signin";

// How long each press's loopback listener stays open. Sign-up happens inside
// this hop and takes minutes; sign-out (cancelAbacusAuth) tears them down early.
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

/** Open listeners at once; past it the oldest press's is closed. */
const MAX_OPEN_ATTEMPTS = 5;

/** base64url(sha256(verifier)), which is what `code_challenge_method=S256` means. */
const codeChallengeFor = (verifier: string): string =>
  crypto.createHash("sha256").update(verifier).digest("base64url");

/**
 * One press of Sign in: its own verifier, callback path and loopback port,
 * each single-use and open until that press's own timeout. A later press does
 * not close it: the tab it opened may be the one the user finishes, and the
 * first press to come back signs the app in, after which the rest close.
 */
interface Attempt {
  close(): void;
  /** Set once the browser has been sent to this attempt's listener. */
  opened: boolean;
}

/** The newest press, the only one whose caller still waits for a key. */
interface Waiter {
  attempt: Attempt;
  settle(result: AbacusAuthResult, reason?: string, hint?: string): void;
}

const attempts = new Set<Attempt>();
let waiter: Waiter | null = null;

const CANCELLED: AbacusAuthResult = {
  ok: false,
  error: "Sign-in was cancelled.",
  cancelled: true,
};

/**
 * Stop waiting for a sign-in. Listeners the browser was already sent to stay
 * valid for the next press (a tab from before can still finish it) unless
 * `everyAttempt`, as on sign-out; with no press waiting, a returning tab is
 * told to try again and nothing is exchanged.
 */
export const cancelAbacusAuth = (options?: {
  everyAttempt?: boolean;
}): void => {
  waiter?.settle(CANCELLED);
  for (const attempt of attempts)
    if (options?.everyAttempt === true || !attempt.opened) attempt.close();
};

/** Open one attempt's loopback listener and send the browser to it. */
const openAttempt = (intent: AbacusAuthIntent): Attempt => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  // A random path segment stands in for an OAuth `state`, so another local
  // process cannot drive the callback by guessing the port.
  const callbackPath = crypto.randomBytes(16).toString("hex");

  let closed = false;
  let accepted = false;
  /** The press this attempt's tab is answering, while the exchange runs. */
  let claimedBy: Waiter | null = null;
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

  /** Fail the waiting press if it is this attempt's. */
  const failOwn = (
    result: AbacusAuthResult,
    reason?: string,
    hint?: string
  ): void => {
    if (waiter?.attempt === attempt) waiter.settle(result, reason, hint);
  };

  /** No longer accepting; a result the tab is reading stays up briefly. */
  const retire = (): void => {
    attempts.delete(attempt);
    if (timer != null) clearTimeout(timer);
    if (outcome.state === "pending") closeServer();
    else linger = setTimeout(closeServer, RESULT_LINGER_MS);
  };

  const attempt: Attempt = {
    opened: false,
    close: () => {
      if (closed) return;
      closed = true;
      failOwn(CANCELLED);
      claimedBy?.settle(CANCELLED);
      abort.abort();
      retire();
    },
  };

  /** The exchange settled: tell the tab, and the press that claimed it. */
  const settleWith = (
    claimed: Waiter,
    result: AbacusAuthResult,
    reason?: string
  ): void => {
    if (closed) return;
    closed = true;
    if (result.ok) {
      outcome = { state: "ok" };
      // The first attempt back wins; every other press's listener closes.
      for (const other of attempts) if (other !== attempt) other.close();
    } else if (reason != null) outcome = { state: "failed", reason };
    retire();
    claimed.settle(result, reason);
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
    if (accepted || closed) {
      res.writeHead(409).end();
      return;
    }
    accepted = true;

    // Whichever press is waiting now is the one this tab answers; taken, so
    // a second tab coming back at the same moment cannot answer it too.
    const claimed = waiter;
    waiter = null;
    claimedBy = claimed;
    if (claimed == null) reportFunnelStep("browser_returned", "unclaimed");
    else reportFunnelStep("browser_returned");

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

    if (claimed == null) {
      // Cancelled with no press since: nothing is waiting for a key, so none
      // is minted, and the tab says to go back and try again.
      closed = true;
      outcome = { state: "failed", reason: "cancelled" };
      retire();
      return;
    }

    if (code == null || code.length === 0) {
      settleWith(
        claimed,
        {
          ok: false,
          error: "Abacus.AI did not return an authorization code.",
        },
        "no_code"
      );
      return;
    }

    void exchange(code, verifier, abort.signal).then(({ result, reason }) =>
      settleWith(claimed, result, reason)
    );
  });

  server.on("error", (error) => {
    failOwn({ ok: false, error: error.message });
    attempt.close();
  });

  // The oldest press's listener makes room; it is the likeliest abandoned.
  if (attempts.size >= MAX_OPEN_ATTEMPTS)
    attempts.values().next().value?.close();
  attempts.add(attempt);

  // Port 0 lets the OS pick; loopback-only so nothing off-machine reaches it.
  server.listen(0, "127.0.0.1", () => {
    if (closed) return;
    const { port } = server.address() as AddressInfo;

    timer = setTimeout(() => {
      failOwn({ ok: false, error: ABACUS_TIMEOUT });
      attempt.close();
    }, AUTH_TIMEOUT_MS);

    const url = new URL(SIGNIN_PATH, abacusAppHost());
    if (intent === "signup") url.searchParams.set("isSignUp", "1");
    url.searchParams.set("AbacusAIBot", "1");
    url.searchParams.set("botChallenge", codeChallengeFor(verifier));
    url.searchParams.set("botPort", String(port));
    url.searchParams.set("botPath", callbackPath);
    reportFunnelStep("signup_clicked", "browser");
    console.log(`[abacus-auth] sign-in intent: ${intent}`);

    attempt.opened = true;
    void shell.openExternal(url.toString()).catch((error: unknown) => {
      failOwn(
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "Could not open the browser.",
        },
        undefined,
        "open_browser"
      );
      attempt.close();
    });
  });

  return attempt;
};

/**
 * Sign-in in the system browser, where an existing abacus.ai session finishes
 * it in one step. `signup` opens the sign-up form, `signin` the sign-in one.
 * An earlier press still waiting is answered as cancelled, but its listener
 * stays valid: its tab can finish this press.
 */
export const startAbacusAuth = (
  intent: AbacusAuthIntent = "signup"
): Promise<AbacusAuthResult> => {
  cancelAbacusAuth();

  return new Promise<AbacusAuthResult>((resolve) => {
    let settled = false;
    const self: Waiter = {
      attempt: openAttempt(intent),
      settle: (result, reason, hint) => {
        if (settled) return;
        settled = true;
        if (waiter === self) waiter = null;
        let outcomeCode = "ok";
        // `=== false`, not `!`: the main tsconfig has strictNullChecks off, and
        // only an equality check narrows the union there.
        if (result.ok === false) {
          outcomeCode =
            reason ??
            hint ??
            (result.cancelled
              ? "cancelled"
              : result.error === ABACUS_TIMEOUT
                ? "timeout"
                : "listener");
        }
        reportFunnelStep("signin_result", outcomeCode);
        // A browser sign-in left the user in the browser: bring them back.
        // win.focus() alone does not activate an app in the background on
        // macOS; stealing focus is the point here, the user just finished.
        if (result.ok) {
          bringToFront();
          try {
            if (process.platform === "darwin") app.focus({ steal: true });
          } catch {
            // No `app` outside electron (tests).
          }
        }
        resolve(result);
      },
    };
    waiter = self;
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
 * The tab shown after the redirect. Its script polls the listener for the
 * exchange outcome: a failure is shown in the tab (the app can only say "try
 * again") and reported to Abacus.AI as a short code through the browser, which
 * reaches it even when the app's own request could not. Without the script the page is exactly what it was.
 */
const responsePage = (): string => {
  let build = "packaged";
  try {
    if (!app.isPackaged) build = "source";
  } catch {
    // No `app` outside electron (tests).
  }
  // The same opt-out as the log sync: with it off, the tab still shows the
  // outcome but reports nothing.
  let reportEnabled = true;
  try {
    reportEnabled = readSettings().serverDebugSync ?? true;
  } catch {
    // Unreadable settings: report, as the log sync would.
  }
  // An API path: an unknown method is answered 404 and logged, which is all
  // the beacon needs.
  const beacon = new URL("/api/v1/_abacusaibotSignInResult", abacusAppHost());
  beacon.searchParams.set("build", build);
  return handoffPage({
    title: "You're signed in",
    body: "Go back to AbacusAI Bot. You can close this tab.",
    script: `
  (function () {
    var beacon = ${JSON.stringify(reportEnabled ? beacon.toString() : "")};
    var url = location.pathname + "/result";
    var tries = 0;
    function report(outcome, reason) {
      if (!beacon) return;
      var img = new Image();
      img.src = beacon + "&outcome=" + encodeURIComponent(outcome) +
        (reason ? "&reason=" + encodeURIComponent(reason) : "");
    }
    function poll() {
      if (tries++ > 40) return;
      fetch(url, { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (o) {
        if (!o || o.state === "pending") { setTimeout(poll, 500); return; }
        if (o.state === "ok") {
          report("ok");
          // The app is already in front again. Browsers only let a script
          // close a tab it opened, so this can fail; the text above stays.
          setTimeout(function () { window.close(); }, 1200);
          return;
        }
        var reason = String(o.reason || "unknown").replace(/[^A-Za-z0-9_]/g, "").slice(0, 32);
        document.getElementById("badge").className = "badge warn";
        // SVG elements have no .hidden property: toggle the attribute.
        document.getElementById("badge-ok").setAttribute("hidden", "");
        document.getElementById("badge-warn").removeAttribute("hidden");
        document.getElementById("title").textContent = "Sign-in didn't finish";
        document.getElementById("body").textContent =
          "Abacus.AI signed you in, but the app could not complete the connection (" + reason + "). " +
          "Go back to the app and try again. If you are running the app from source, the terminal has the full error on a line starting with [abacus-auth].";
        report("failed", reason);
      }).catch(function () { setTimeout(poll, 500); });
    }
    poll();
  })();
  `,
  });
};
