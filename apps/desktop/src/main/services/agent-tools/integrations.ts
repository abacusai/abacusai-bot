/**
 * Third-party integrations: Home Assistant, and X search. Thin REST wrappers
 * by design; a small surface is easier to keep correct as those APIs move.
 */

import { credentialFor } from "../config/settings";
import { resolveAbacusApiKey } from "../providers/abacus";
import { abacusRoutellmV1 } from "../providers/abacus-host";

// Environment first, then Settings → API keys: a packaged app launched from
// Finder has an empty environment (see credentialFor).
const env = (name: string): string => credentialFor(name);

const call = async (
  url: string,
  init: RequestInit = {},
  timeoutMs = 30_000
): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });

    if (!response.ok) {
      throw new Error(
        `${response.status} ${response.statusText}: ${(await response.text()).slice(0, 300)}`
      );
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
};

// ── Home Assistant ─────────────────────────────────────────────────────────

const haBase = (): string => env("HOMEASSISTANT_URL").replace(/\/+$/, "");

export const homeAssistantReady = (): boolean =>
  haBase().length > 0 && env("HOMEASSISTANT_TOKEN").length > 0;

export const homeAssistantSetupHint =
  "Home Assistant is not configured. Set HOMEASSISTANT_URL (e.g. http://homeassistant.local:8123) and HOMEASSISTANT_TOKEN (Profile → Long-lived access tokens).";

const haHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${env("HOMEASSISTANT_TOKEN")}`,
  "Content-Type": "application/json",
});

interface HaState {
  entity_id?: string;
  state?: string;
  attributes?: { friendly_name?: string };
}

/**
 * List entities, optionally filtered. A real installation has hundreds, so the
 * filter is applied here and the left-out count is reported, not truncated.
 */
export const haListEntities = async (filter?: string): Promise<string> => {
  const states = (await call(`${haBase()}/api/states`, {
    headers: haHeaders(),
  })) as HaState[];
  const needle = (filter ?? "").trim().toLowerCase();

  const matching = states.filter((entity) => {
    if (needle.length === 0) return true;

    return (
      (entity.entity_id ?? "").toLowerCase().includes(needle) ||
      (entity.attributes?.friendly_name ?? "").toLowerCase().includes(needle)
    );
  });

  if (matching.length === 0) {
    return needle.length > 0
      ? `No entity matches "${filter}".`
      : "Home Assistant reported no entities.";
  }

  const shown = matching.slice(0, 100);
  const lines = shown.map(
    (entity) =>
      `${entity.entity_id} — ${entity.attributes?.friendly_name ?? "unnamed"} [${entity.state}]`
  );

  if (matching.length > shown.length) {
    lines.push(
      `… and ${matching.length - shown.length} more. Narrow it with the filter argument.`
    );
  }

  return lines.join("\n");
};

export const haGetState = async (entityId: string): Promise<string> => {
  const entity = (await call(
    `${haBase()}/api/states/${encodeURIComponent(entityId)}`,
    {
      headers: haHeaders(),
    }
  )) as HaState & { attributes?: Record<string, unknown> };

  return [
    `${entity.entity_id}: ${entity.state}`,
    JSON.stringify(entity.attributes ?? {}, null, 2),
  ].join("\n");
};

export const haListServices = async (domain?: string): Promise<string> => {
  const services = (await call(`${haBase()}/api/services`, {
    headers: haHeaders(),
  })) as Array<{
    domain?: string;
    services?: Record<string, unknown>;
  }>;

  const wanted = (domain ?? "").trim().toLowerCase();
  const matching =
    wanted.length > 0
      ? services.filter((entry) => entry.domain === wanted)
      : services;

  if (matching.length === 0) return `No services for domain "${domain}".`;

  return matching
    .map(
      (entry) =>
        `${entry.domain}: ${Object.keys(entry.services ?? {}).join(", ")}`
    )
    .join("\n");
};

export const haCallService = async (
  domain: string,
  service: string,
  entityId?: string,
  data?: Record<string, unknown>
): Promise<string> => {
  await call(
    `${haBase()}/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`,
    {
      method: "POST",
      headers: haHeaders(),
      body: JSON.stringify({
        ...(entityId != null ? { entity_id: entityId } : {}),
        ...data,
      }),
    }
  );

  return `Called ${domain}.${service}${entityId != null ? ` on ${entityId}` : ""}.`;
};

// ── X search ───────────────────────────────────────────────────────────────

/**
 * X search through the platform's X API access, on the Abacus key the app
 * already holds: the same call DeepAgent's real_time_search makes, billed
 * per request. Without a key the agent's own `x_search` scopes a normal web
 * search to x.com.
 */
export const xSearchReady = (): boolean => resolveAbacusApiKey() != null;

export const xSearchSetupHint =
  "X search runs on your Abacus.AI account. Sign in from the model list first; " +
  "until then the agent searches x.com through its normal web search instead.";

/** Overridable so tests can use a loopback stub. */
const xSearchUrl = (): string =>
  process.env.ABACUSAI_BOT_X_SEARCH_URL ||
  `${abacusRoutellmV1()}/abacusaibot_x_search`;

export const xSearch = async (query: string): Promise<string> => {
  const body = (await call(
    xSearchUrl(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resolveAbacusApiKey() ?? ""}`,
      },
      body: JSON.stringify({ query, num_results: 20 }),
    },
    60_000
  )) as { results?: unknown[]; text?: string };

  return (body.results ?? []).length > 0 && typeof body.text === "string"
    ? body.text
    : `No results for "${query}".`;
};
