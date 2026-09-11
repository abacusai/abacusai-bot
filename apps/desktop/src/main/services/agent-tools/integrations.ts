/**
 * Third-party integrations: Home Assistant, and X search. Thin REST wrappers
 * by design; a small surface is easier to keep correct as those APIs move.
 */

import { credentialFor, readXaiSearchEnabled } from "../config/settings";

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
 * X search through xAI, only when asked for: the key alone is a model choice,
 * not consent to send query text to api.x.ai, so the Capabilities toggle is
 * required too (see readXaiSearchEnabled). Otherwise the agent's own
 * `x_search` scopes a normal web search to x.com.
 */
export const xSearchReady = (): boolean =>
  env("XAI_API_KEY").length > 0 && readXaiSearchEnabled();

export const xSearchSetupHint =
  "X search through X's own index needs XAI_API_KEY plus the xAI Live Search " +
  "switch under Capabilities. Without both, the agent searches x.com through " +
  "its normal web search instead.";

/** Overridable so tests can use a loopback stub and a proxy needs no code change. */
const xBase = (): string =>
  (process.env.ABACUSAI_BOT_X_BASE_URL || "https://api.x.ai/v1").replace(
    /\/+$/,
    ""
  );

/**
 * Search X through xAI's chat completions with Live Search on: xAI exposes X
 * search as a model tool, so the result is a cited summary, not a post list.
 */
export const xSearch = async (query: string): Promise<string> =>
  await xSearchViaXai(query);

const xSearchViaXai = async (query: string): Promise<string> => {
  const body = (await call(
    `${xBase()}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env("XAI_API_KEY")}`,
      },
      body: JSON.stringify({
        model: env("ABACUSAI_BOT_X_MODEL") || "grok-4",
        messages: [
          {
            role: "user",
            content: `Search X for: ${query}\n\nReport what you find, with links to the posts.`,
          },
        ],
        search_parameters: { mode: "on", sources: [{ type: "x" }] },
      }),
    },
    60_000
  )) as {
    choices?: Array<{ message?: { content?: string } }>;
    citations?: string[];
  };

  const text = body.choices?.[0]?.message?.content ?? "";

  if (text.trim().length === 0) return `No results for "${query}".`;

  const citations = (body.citations ?? []).slice(0, 10);

  return citations.length > 0
    ? `${text}\n\nSources:\n${citations.map((url) => `- ${url}`).join("\n")}`
    : text;
};
