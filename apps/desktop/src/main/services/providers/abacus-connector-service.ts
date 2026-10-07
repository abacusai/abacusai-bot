import { connectorForService } from "@abacus-ai/connectors/registry";
import type {
  AbacusConnectorInfo,
  AbacusConnectorOutcome,
  AbacusConnectorsSnapshot,
  ConnectorConnectOptions,
} from "@abacus-ai/contract/contracts";

import { credentialFor } from "../config/settings";
import { abacusAppHost, abacusUserAgent } from "./abacus-host";

/**
 * Abacus.AI first-party connectors (Gmail, Slack, Drive, ...). The platform
 * owns the OAuth flow: connecting opens its connect page, which mints a link
 * bound to the signed-in user. Tools arrive via the `abacus-connectors` MCP
 * entry, whose Bearer header is an env placeholder the agent resolves, so the
 * key is never written into mcp-code.json.
 */

const CONNECT_PATH = "/chatllm/connect-connector";

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
 * enters the app. The bot's catalog includes link-only connectors such as
 * GitHub. Exported for tests.
 */
export const buildConnectorsSnapshot = (
  botConnectors: unknown,
  activeUserConnectors: unknown
): AbacusConnectorsSnapshot => {
  const available: AbacusConnectorInfo[] = [];
  if (botConnectors != null && typeof botConnectors === "object") {
    for (const [service, config] of Object.entries(
      botConnectors as Record<string, unknown>
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
    // The bot's own catalog (org policy applied); connected state is per user.
    const [catalog, active] = await Promise.all([
      abacusApi("_listAbacusbotConnectors", "POST", {}),
      abacusApi("_listActiveUserLevelConnectors", "POST", {}),
    ]);
    if (catalog == null && active == null) {
      return {
        ok: false,
        error: "unavailable",
        available: [],
        connected: {},
        accounts: {},
      };
    }
    return buildConnectorsSnapshot(catalog, active);
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

/** One Google consent attaches all of these; a link for any of them asks for the bundle. */
export const GOOGLE_BUNDLE_SERVICES = [
  "gmailuser",
  "googledriveuser",
  "googlecalendar",
] as const;

/** The string items of a server list, or none. */
const serviceKeys = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

/**
 * A one-tap connect link (WhatsApp, or a chat in the app), the services its
 * consent asks for, and, for a bundle, the members already connected, which
 * it leaves out. The server mints a request only its owner's browser can use
 * and the page spends it once connected; a server that will not mint one
 * gets the plain page for the one service. Null when signed out.
 */
export const createConnectLink = async (
  service: string
): Promise<{
  url: string;
  services: string[];
  connected: string[];
  requestId?: string;
} | null> => {
  const serviceKey = service.toLowerCase();
  if (!SERVICE_RE.test(serviceKey) || abacusApiKey().length === 0) return null;
  const bundled = (GOOGLE_BUNDLE_SERVICES as readonly string[]).includes(
    serviceKey
  );
  const minted = await abacusApiCall("_createAbacusbotConnectLink", "POST", {
    service: bundled ? "google" : serviceKey,
  });
  const request = minted.ok
    ? (minted.result as {
        requestId?: unknown;
        services?: unknown;
        connected?: unknown;
        url?: unknown;
      } | null)
    : null;
  const url = new URL(CONNECT_PATH, abacusAppHost());
  if (
    typeof request?.requestId === "string" &&
    Array.isArray(request.services)
  ) {
    url.searchParams.set("service", bundled ? "google" : serviceKey);
    url.searchParams.set("r", request.requestId);
    url.searchParams.set("autostart", "1");
    return {
      // The server's own link when it gives one: a page whose preview card
      // names the service, on its way to the same connect page.
      url:
        typeof request.url === "string" && request.url.startsWith("https://")
          ? request.url
          : url.toString(),
      services: serviceKeys(request.services),
      connected: serviceKeys(request.connected),
      requestId: request.requestId,
    };
  }
  url.searchParams.set("service", serviceKey);
  url.searchParams.set("autostart", "1");
  return { url: url.toString(), services: [serviceKey], connected: [] };
};

/**
 * What a link from createConnectLink has done: not completed until its
 * connect lands, then the services it connected and those its consent did not
 * grant (left unticked on the provider's screen). Null when the server cannot
 * say, so the caller falls back to the connector statuses.
 */
export const connectLinkStatus = async (
  requestId: string
): Promise<{
  completed: boolean;
  connected: string[];
  notGranted: string[];
} | null> => {
  const status = await abacusApiCall("_getAbacusbotConnectLinkStatus", "POST", {
    requestId,
  });
  const result = status.ok
    ? (status.result as {
        completed?: unknown;
        connected?: unknown;
        notGranted?: unknown;
      } | null)
    : null;
  if (typeof result?.completed !== "boolean") return null;
  return {
    completed: result.completed,
    connected: serviceKeys(result.connected),
    notGranted: serviceKeys(result.notGranted),
  };
};

/** An account hint is forwarded to the provider only when it reads as an email. */
const HINT_RE = /^[^\s@/?#&]{1,64}@[^\s@/?#&]{1,255}$/;

/**
 * The connect page for one service, for the caller to open. The page mints
 * its own owner-bound link for the signed-in user and starts the provider's
 * consent on load; nothing waits here.
 */
export const connectPageUrl = (
  service: string,
  options: ConnectorConnectOptions = {}
): AbacusConnectorOutcome => {
  const serviceKey = service.toLowerCase();
  if (!SERVICE_RE.test(serviceKey))
    return { ok: false, error: "Unknown connector." };
  if (abacusApiKey().length === 0) return { ok: false, error: "not-signed-in" };
  const url = new URL(CONNECT_PATH, abacusAppHost());
  url.searchParams.set("service", serviceKey);
  url.searchParams.set("autostart", "1");
  const hint = (options.hint ?? "").trim();
  if (HINT_RE.test(hint)) url.searchParams.set("hint", hint);
  return { ok: true, url: url.toString() };
};
