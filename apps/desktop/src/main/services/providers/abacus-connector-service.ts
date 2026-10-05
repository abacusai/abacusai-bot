import crypto from "crypto";
import http from "http";
import type { AddressInfo } from "net";

import { connectorForService } from "@abacus-ai/connectors/registry";
import type {
  AbacusConnectorInfo,
  AbacusConnectorOutcome,
  AbacusConnectorsSnapshot,
  ConnectorConnectOptions,
} from "@abacus-ai/contract/contracts";
import { shell } from "electron";

import { bringToFront } from "../../bring-to-front";
import { credentialFor } from "../config/settings";
import { openConnectWindow, type ConnectWindow } from "./abacus-connect-window";
import { abacusAppHost, abacusUserAgent } from "./abacus-host";
import { readAccountState } from "./account-service";
import { sessionHolds } from "./sign-in-session";

/**
 * Abacus.AI first-party connectors (Gmail, Slack, Drive, ...). The platform
 * owns the OAuth flow, so connecting is a loopback browser hop like sign-in,
 * except nothing secret travels: the ping only says "done". Tools arrive via
 * the `abacus-connectors` MCP entry, whose Bearer header is an env placeholder
 * the agent resolves, so the key is never written into mcp-code.json.
 */

const CONNECT_PATH = "/chatllm/connect-connector";
// Twenty minutes: account choice, scope review and a 2FA prompt outrun shorter
// windows. Every auth window in the app uses the same ceiling.
const CONNECT_TIMEOUT_MS = 20 * 60 * 1000;

/** Connector keys are platform service names: lowercase, e.g. "gmailuser". */
const SERVICE_RE = /^[a-z0-9_]{2,40}$/;

const apiUrl = (method: string): URL =>
  new URL(`/api/v1/${method}`, abacusAppHost());

const abacusApiKey = (): string => credentialFor("ABACUS_API_KEY");

/**
 * One platform API call with the stored key. Success is reported apart from
 * the payload because a successful DELETE returns null. Failure detail is
 * logged, not surfaced: server-influenced text never renders in a dialog.
 */
export const abacusApiCall = async (
  method: string,
  httpMethod: "POST" | "DELETE" | "GET",
  body?: Record<string, unknown>
): Promise<{ ok: boolean; result: unknown }> => {
  const key = abacusApiKey();
  if (key.length === 0) return { ok: false, result: null };
  try {
    const url = apiUrl(method);
    if (httpMethod !== "POST" && body != null) {
      for (const [name, value] of Object.entries(body)) {
        url.searchParams.set(name, String(value));
      }
    }
    const response = await fetch(url, {
      method: httpMethod,
      headers: {
        apikey: key,
        // Cloudflare 403s Node's default agent. See abacusUserAgent.
        "user-agent": abacusUserAgent(),
        ...(httpMethod === "POST"
          ? { "content-type": "application/json" }
          : {}),
      },
      ...(httpMethod === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    const payload = (await response.json().catch(() => null)) as {
      success?: unknown;
      result?: unknown;
      error?: unknown;
    } | null;
    if (!response.ok || payload?.success !== true) {
      console.warn(
        `[abacus-connectors] ${method} failed: HTTP ${response.status} ${
          typeof payload?.error === "string" ? payload.error.slice(0, 200) : ""
        }`
      );
      return { ok: false, result: null };
    }
    return { ok: true, result: payload.result ?? null };
  } catch (error) {
    console.warn(
      `[abacus-connectors] ${method} error: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return { ok: false, result: null };
  }
};

/** The payload alone, for the two listing calls that only care about that. */
const abacusApi = async (
  method: string,
  httpMethod: "POST" | "DELETE" | "GET",
  body?: Record<string, unknown>
): Promise<unknown | null> =>
  (await abacusApiCall(method, httpMethod, body)).result;

/**
 * Shape the two platform responses into the snapshot the app consumes. Only
 * services the registry has an entry for come through, in either list: the
 * registry is the allowlist, and this is the one place the platform's catalog
 * enters the app. (GitHub, for one, is a token on its own card here, and the
 * platform's GitHub App never appears.) Exported for tests.
 */
export const buildConnectorsSnapshot = (
  validAgentConnectors: unknown,
  activeUserConnectors: unknown
): AbacusConnectorsSnapshot => {
  const available: AbacusConnectorInfo[] = [];
  if (
    validAgentConnectors != null &&
    typeof validAgentConnectors === "object"
  ) {
    for (const [service, config] of Object.entries(
      validAgentConnectors as Record<string, unknown>
    )) {
      if (connectorForService(service) == null) continue;
      const record =
        config != null && typeof config === "object"
          ? (config as Record<string, unknown>)
          : {};
      available.push({
        service: service.toLowerCase(),
        name:
          typeof record.name === "string" && record.name.length > 0
            ? record.name
            : service,
      });
    }
  }

  // Null-prototype: keys are wire service names, and a plain object would
  // answer to "constructor" as if it were connected.
  const connected: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  const accounts: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  if (Array.isArray(activeUserConnectors)) {
    for (const item of activeUserConnectors) {
      if (item == null || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const service =
        typeof record.service === "string" ? record.service.toLowerCase() : "";
      const connectorId =
        typeof record.applicationConnectorId === "string"
          ? record.applicationConnectorId
          : typeof record.databaseConnectorId === "string"
            ? record.databaseConnectorId
            : "";
      if (
        service.length > 0 &&
        connectorId.length > 0 &&
        connectorForService(service) != null
      ) {
        connected[service] = connectorId;
        // The platform's label ("Gmail - ada@example.com") is kept whole
        // rather than parsed: the format is theirs to change.
        if (typeof record.name === "string" && record.name.length > 0) {
          accounts[service] = record.name;
        }
      }
    }
  }

  return { ok: true, available, connected, accounts };
};

export const listAbacusConnectors =
  async (): Promise<AbacusConnectorsSnapshot> => {
    if (abacusApiKey().length === 0) {
      return {
        ok: false,
        error: "not-signed-in",
        available: [],
        connected: {},
        accounts: {},
      };
    }
    const [valid, active] = await Promise.all([
      abacusApi("_listValidAgentConnectors", "POST", {}),
      abacusApi("_listActiveUserLevelConnectors", "POST", {}),
    ]);
    if (valid == null && active == null) {
      return {
        ok: false,
        error: "unavailable",
        available: [],
        connected: {},
        accounts: {},
      };
    }
    return buildConnectorsSnapshot(valid, active);
  };

const DISCONNECT_FAILED = "Could not disconnect. Please try again.";

export const disconnectAbacusConnector = async (
  service: string
): Promise<AbacusConnectorOutcome> => {
  // A service name that could not be a platform key never reaches the platform.
  const serviceKey = service.toLowerCase();
  if (!SERVICE_RE.test(serviceKey)) {
    return { ok: false, error: "Unknown connector." };
  }

  const snapshot = await listAbacusConnectors();
  const connectorId = Object.hasOwn(snapshot.connected, serviceKey)
    ? snapshot.connected[serviceKey]
    : undefined;
  if (connectorId == null) {
    return { ok: false, error: "This service is not connected." };
  }

  const deleted = await abacusApiCall("_deleteUserConnector", "DELETE", {
    applicationConnectorId: connectorId,
  });

  // A successful DELETE carries no payload, so the connector list confirms it;
  // when that list is unavailable the DELETE's own status is the best evidence.
  const after = await listAbacusConnectors();
  if (after.ok) {
    return Object.hasOwn(after.connected, serviceKey)
      ? { ok: false, error: DISCONNECT_FAILED }
      : { ok: true };
  }

  return deleted.ok ? { ok: true } : { ok: false, error: DISCONNECT_FAILED };
};

/**
 * Is this service attached, as far as the platform will say? Asked more than
 * once: the listing transiently shrinks (see seenAvailable) and lags a
 * just-finished OAuth hop. Exported with an injectable lister for its test.
 */
export const confirmConnected = async (
  serviceKey: string,
  list: () => Promise<AbacusConnectorsSnapshot> = listAbacusConnectors,
  attempts = 5,
  delayMs = 2_000
): Promise<"connected" | "absent" | "unavailable"> => {
  let sawListing = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0)
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    const snapshot = await list();
    if (!snapshot.ok) continue;
    sawListing = true;
    if (snapshot.connected[serviceKey] != null) return "connected";
  }
  return sawListing ? "absent" : "unavailable";
};

/**
 * Hops in flight, one per service: a second hop for the same service
 * supersedes the first, and hops for different services run side by side.
 * Each remembers who started it (see ConnectorConnectOptions.owner).
 */
const inFlight = new Map<
  string,
  { close: () => void; owner: string | undefined }
>();

/**
 * Cancel the hops a caller owns: with no owner, the ones screens start on a
 * click, which is what a screen leaving should take down; with one, only
 * that owner's. Onboarding's automatic Gmail hop was once cancelled by the
 * Connectors step's cleanup, and, being once per install, never ran again.
 */
export const cancelConnectorConnect = (owner?: string): void => {
  const doomed = [...inFlight].filter(([, hop]) => hop.owner === owner);
  for (const [service, hop] of doomed) {
    inFlight.delete(service);
    hop.close();
  }
};

/** Every hop, whoever started it: sign-out, quit. */
export const cancelAllConnectorConnects = (): void => {
  const doomed = [...inFlight.values()];
  inFlight.clear();
  for (const hop of doomed) hop.close();
};

/**
 * Browser hop: open the connect page with a loopback port + secret path, wait
 * for its "done" ping, then confirm against the platform. Listener discipline
 * (GET-only, Host-checked, single-shot, timed) follows startAbacusAuth.
 */
/** An account hint is forwarded to the provider only when it reads as an email. */
const HINT_RE = /^[^\s@/?#&]{1,64}@[^\s@/?#&]{1,255}$/;

export const startConnectorConnect = (
  service: string,
  options: ConnectorConnectOptions = {}
): Promise<AbacusConnectorOutcome> => {
  const serviceKey = service.toLowerCase();
  // The same service again supersedes: one loopback per connector.
  inFlight.get(serviceKey)?.close();
  inFlight.delete(serviceKey);

  if (!SERVICE_RE.test(serviceKey)) {
    return Promise.resolve({ ok: false, error: "Unknown connector." });
  }
  if (abacusApiKey().length === 0) {
    return Promise.resolve({ ok: false, error: "not-signed-in" });
  }

  const callbackPath = crypto.randomBytes(16).toString("hex");

  return new Promise<AbacusConnectorOutcome>((resolve) => {
    let settled = false;
    let accepted = false;
    let timer: NodeJS.Timeout | null = null;
    let window: ConnectWindow | null = null;
    /** Where the hop ran, for the wording of a wrong-account outcome. */
    let surface: "app" | "browser" = "browser";

    const server = http.createServer((req, res) => {
      const host = (req.headers.host ?? "").toLowerCase();
      if (
        req.method !== "GET" ||
        !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)
      ) {
        res.writeHead(404).end();
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== `/${callbackPath}`) {
        res.writeHead(404).end();
        return;
      }
      if (accepted) {
        res.writeHead(409).end();
        return;
      }
      accepted = true;

      res
        .writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        })
        .end(RESPONSE_PAGE);

      // The ping is advisory and the platform is the truth, but its listing
      // lags the hop and sometimes fails, so confirmation retries and the ping
      // stands in when the platform never answers.
      void confirmConnected(serviceKey).then((confirmed) => {
        if (confirmed === "absent") {
          // The provider said done, the platform lists nothing: the session
          // the hop ran on belongs to a different Abacus account, and the
          // connector attached over there. "Try again" fails the same way;
          // the UI words the way out for the surface the hop ran on.
          finish({
            ok: false,
            code: "wrong-account",
            surface,
            error:
              surface === "browser"
                ? "The sign-in finished, but the connector did not appear on " +
                  "this app's Abacus account. Your browser is signed into a " +
                  "different Abacus account, and the connector attached " +
                  "there instead. In the browser, sign into the same account " +
                  "this app uses, then connect again."
                : "The sign-in finished, but the connector did not appear on " +
                  "this app's Abacus account: the app's sign-in window held a " +
                  "different account. Sign out and back in, then connect again.",
          });
        } else if (confirmed === "unavailable" && abacusApiKey().length === 0) {
          // The account signed out while the hop was out: whatever attached
          // is not this app's, and "connected" would be a lie.
          finish({ ok: false, error: "not-signed-in" });
        } else {
          finish({ ok: true });
        }
      });
    });

    /**
     * Settle the hop and bring the app back in front: on macOS a full-screen
     * window sits in its own Space and nothing else moves the user back.
     * `reveal` is off for an unconfirmed timeout, where they are probably
     * still signing in and a focus steal would interrupt it.
     */
    const finish = (
      result: AbacusConnectorOutcome,
      { reveal = true }: { reveal?: boolean } = {}
    ): void => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      server.closeAllConnections?.();
      server.close();
      if (inFlight.get(serviceKey)?.close === close)
        inFlight.delete(serviceKey);
      window?.close();
      window = null;
      if (reveal) bringToFront();
      resolve(result);
    };

    const close = (): void => {
      finish({
        ok: false,
        error: "Connecting was cancelled.",
        cancelled: true,
      });
    };

    server.on("error", (error) => {
      finish({ ok: false, error: error.message });
    });

    inFlight.set(serviceKey, { close, owner: options.owner });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;

      timer = setTimeout(() => {
        // The ping may never land (tab closed early, redirect blocked); ask
        // the platform before calling it a timeout.
        void confirmConnected(serviceKey, listAbacusConnectors, 3).then(
          (confirmed) => {
            if (confirmed === "connected") {
              finish({ ok: true });
            } else {
              finish(
                {
                  ok: false,
                  error:
                    "Timed out waiting for the connection. The user may still be mid-sign-in. Call connect_connector for it again to keep waiting; an an account attached late is picked up then.",
                },
                // They are most likely still signing in; leave them to it.
                { reveal: false }
              );
            }
          }
        );
      }, CONNECT_TIMEOUT_MS);

      const connectUrl = new URL(CONNECT_PATH, abacusAppHost());
      connectUrl.searchParams.set("service", serviceKey);
      connectUrl.searchParams.set("botPort", String(port));
      connectUrl.searchParams.set("botPath", callbackPath);
      if (options.autostart === true)
        connectUrl.searchParams.set("autostart", "1");
      const hint = (options.hint ?? "").trim();
      if (HINT_RE.test(hint)) connectUrl.searchParams.set("hint", hint);

      const openInBrowser = (): void => {
        void shell
          .openExternal(connectUrl.toString())
          .catch((error: unknown) => {
            finish({
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Could not open the browser.",
            });
          });
      };

      // The account that signed in inside the app has its session in the
      // app's own partition, not in the browser: the hop runs in an app
      // window on that session, and the connect page can go straight to the
      // provider. Only when the partition holds this very account; a stale
      // session of another account would attach the connector over there.
      void sessionHolds(readAccountState().account?.email)
        .catch(() => false)
        .then((inApp) => {
          if (settled) return;
          console.log(
            `[abacus-connectors] ${serviceKey} hop: ${inApp ? "app window" : "browser"}`
          );
          if (inApp) {
            window = openConnectWindow({
              url: connectUrl.toString(),
              port,
              callbackPath,
              onHandOff: openInBrowser,
              // Closed after the provider's ping landed is done, not cancelled.
              onDismissed: () => {
                if (!accepted) close();
              },
            });
            if (window != null) {
              surface = "app";
              return;
            }
          }
          openInBrowser();
        });
    });
  });
};

const RESPONSE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Connector attached</title>
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
    <h1>Connector attached</h1>
    <p>You can close this tab and go back to the app.</p>
  </div>
</body>
</html>`;
