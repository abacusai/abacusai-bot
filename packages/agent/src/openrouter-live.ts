/**
 * OpenRouter's live catalog, for what the bundled snapshot cannot say: which
 * models take tools. The agent sends tools with every request, and a model
 * without them answers each one with "No endpoints found that support tool
 * use": a music model in the free tier, or a text model whose free endpoint
 * dropped tools since the snapshot was cut. Read once per process; offline,
 * the snapshot stands and the pool behaves as before.
 */

const CATALOG_URL = "https://openrouter.ai/api/v1/models";

export interface OpenRouterCatalogEntry {
  id: string;
  supported_parameters?: string[];
}

/** Whether a catalog entry takes tools; an older entry without the field is assumed to. */
export const supportsTools = (entry: {
  supported_parameters?: string[];
}): boolean => {
  const parameters = entry.supported_parameters;

  return parameters == null || parameters.includes("tools");
};

/** Ids the live catalog names and says take tools; null until a fetch succeeds. */
let toolCapable: Set<string> | null = null;

export async function refreshOpenRouterLive(
  apiKey = (process.env.OPENROUTER_API_KEY ?? "").trim(),
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (apiKey.length === 0 || toolCapable != null) return;

  try {
    const response = await fetchImpl(CATALOG_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) return;

    const body = (await response.json()) as { data?: OpenRouterCatalogEntry[] };
    const entries = body.data ?? [];

    if (entries.length === 0) return;

    toolCapable = new Set(
      entries.filter(supportsTools).map((entry) => entry.id)
    );
  } catch {
    // Offline, rate-limited, or a shape we do not recognise: the snapshot stands.
  }
}

/**
 * Whether an OpenRouter model may take tools: what the live catalog says when
 * it has answered, and yes otherwise. A model the live catalog no longer lists
 * is out too: a retired free slug fails the same way.
 */
export function openRouterTakesTools(modelId: string): boolean {
  return toolCapable == null || toolCapable.has(modelId);
}

/** Test seam. */
export function resetOpenRouterLiveForTesting(): void {
  toolCapable = null;
}
