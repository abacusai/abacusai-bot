import { readSettings } from "../config/settings";

/**
 * Groq's live model list, as a set of ids the key can run. The bundled
 * catalog names models Groq has since retired (the Llama 3.x line), and a
 * retired one answers every turn with a 404. Cached for the process lifetime
 * after a successful fetch; a failure yields null so the caller keeps the
 * catalog as it is rather than emptying the provider.
 */

const CATALOG_URL = "https://api.groq.com/openai/v1/models";
const ENV_VAR = "GROQ_API_KEY";

interface GroqModel {
  id: string;
  active?: boolean;
}

let cache: Set<string> | null = null;

const resolveKey = (): string | undefined => {
  const fromEnv = process.env[ENV_VAR];
  if (fromEnv != null && fromEnv.length > 0) return fromEnv;

  return readSettings().apiKeys?.[ENV_VAR];
};

export const fetchLiveGroqModelIds = async (): Promise<Set<string> | null> => {
  const key = resolveKey();

  if (key == null || key.length === 0) return null;

  try {
    const response = await fetch(CATALOG_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) return cache;

    const body = (await response.json()) as { data?: GroqModel[] };
    const ids = new Set(
      (body.data ?? [])
        .filter((model) => model.active !== false)
        .map((model) => model.id)
    );

    // An empty answer is a shape we do not understand, not an empty account.
    if (ids.size === 0) return cache;

    cache = ids;

    return ids;
  } catch {
    return cache;
  }
};

/** The live ids, if a fetch already succeeded this run. */
export const cachedLiveGroqModelIds = (): Set<string> | null => cache;

export const clearGroqCache = (): void => {
  cache = null;
};
