import type { ModelAvailability } from "#shared/models";

import { hasCredential, readSettings } from "../config/settings";

/**
 * OpenRouter's live free-model list; a hardcoded one goes stale within weeks.
 * Cached for the process lifetime after a successful fetch. A failure returns
 * nothing rather than throwing so the rest of the model list still works.
 */

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const ENV_VAR = "OPENROUTER_API_KEY";

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: string[];
}

let cache: ModelAvailability[] | null = null;

/**
 * Every request here carries tools, and a model without them answers "No
 * endpoints found that support tool use" to each one: a music model outputs
 * text too, so the modality test alone let one into the picker. The agent's
 * pool applies the same reading of the catalog (openrouter-live.ts there).
 */
const supportsTools = (model: OpenRouterModel): boolean => {
  const parameters = model.supported_parameters;

  // Absent on an older entry: assume yes, as with the modalities.
  return parameters == null || parameters.includes("tools");
};

/** The free tier includes image and music models, unusable in a coding agent. */
const isTextModel = (model: OpenRouterModel): boolean => {
  const outputs = model.architecture?.output_modalities;

  // Older catalog entries omit the field; assume text rather than dropping them.
  return outputs == null || outputs.includes("text");
};

const isFree = (model: OpenRouterModel): boolean => {
  // Prices arrive as decimal strings ("0", "0.0000012"). Zero on both sides is
  // the definition of the free tier.
  const prompt = Number(model.pricing?.prompt ?? "1");
  const completion = Number(model.pricing?.completion ?? "1");

  return prompt === 0 && completion === 0;
};

const resolveKey = (): string | undefined => {
  const fromEnv = process.env[ENV_VAR];
  if (fromEnv != null && fromEnv.length > 0) return fromEnv;

  return readSettings().apiKeys?.[ENV_VAR];
};

export const fetchFreeOpenRouterModels = async (): Promise<
  ModelAvailability[]
> => {
  const key = resolveKey();

  if (key == null || key.length === 0) return [];

  try {
    const response = await fetch(CATALOG_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) return [];

    const body = (await response.json()) as { data?: OpenRouterModel[] };

    const models: ModelAvailability[] = (body.data ?? [])
      .filter(
        (model) => isFree(model) && isTextModel(model) && supportsTools(model)
      )
      .map((model) => ({
        id: `openrouter/${model.id}`,
        label: (model.name ?? model.id).replace(/\s*\(free\)\s*$/i, ""),
        provider: "openrouter",
        tier: "free" as const,
        note: "Free on OpenRouter",
        requiresEnv: ENV_VAR,
        configured: hasCredential(ENV_VAR),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    cache = models;

    return models;
  } catch {
    // Offline, rate-limited, or a shape we don't recognise. The built-in catalog
    // still stands on its own.
    return withCurrentConfigured(cache);
  }
};

/** Cached list, if a fetch already succeeded this run. */
export const cachedFreeOpenRouterModels = (): ModelAvailability[] =>
  withCurrentConfigured(cache);

/**
 * `configured` must reflect the key as it is now: the cache outlives key saves
 * and removals.
 */
const withCurrentConfigured = (
  models: ModelAvailability[] | null
): ModelAvailability[] => {
  if (models == null) return [];
  const configured = hasCredential(ENV_VAR);
  return models.map((model) =>
    model.configured === configured ? model : { ...model, configured }
  );
};

export const clearOpenRouterCache = (): void => {
  cache = null;
};
