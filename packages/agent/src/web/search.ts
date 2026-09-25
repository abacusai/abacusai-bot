/**
 * Searching the web through a model provider the user has already configured,
 * via its server-side search tool, so no second key is needed. Each provider is
 * a request and a parser; the seam is `SearchResult`.
 *
 * STRICT MODE: results are read ONLY from structured citation data
 * (`web_search_tool_result`, `url_citation`, `groundingChunks`), never from
 * the model's prose. A model that did not search will write plausible URLs,
 * and a scraper cannot tell those from real ones. Every provider owes this.
 */
import Anthropic from "@anthropic-ai/sdk";

import { abacusV1BaseUrl } from "../abacus-endpoint.js";
import { loadConfig } from "../config.js";

export interface SearchSource {
  url: string;
  title: string;
  snippet?: string;
  publishedAt?: string;
}

export interface SearchResult {
  sources: SearchSource[];
  /** The provider's own summary, when it gave one worth passing on. */
  summary?: string;
}

export class WebSearchError extends Error {
  constructor(
    readonly code: "NO_PROVIDER" | "PROVIDER_ERROR" | "NO_RESULTS",
    message: string
  ) {
    super(message);
    this.name = "WebSearchError";
  }
}

interface RunOptions {
  maxResults: number;
  signal?: AbortSignal;
}

interface Provider {
  id: string;
  /** The key that both configures and selects this provider. */
  envVar: string;
  /** Backend model, for the providers that answer by spending a model turn. */
  model?: string;
  run: (
    query: string,
    key: string,
    options: RunOptions
  ) => Promise<SearchResult>;
}

/** The prompt every provider sends. Kept identical so results are comparable. */
const prompt = (query: string): string =>
  `Search the web for: ${query}\n\n` +
  "Use your web search tool. Then answer in two or three sentences, citing what you found.";

/**
 * The model that runs the search: a backend, not the session's model, so a
 * local coding model does not decide whether search works. Each provider has a
 * default; ABACUSAI_BOT_SEARCH_MODEL overrides whichever is selected.
 */
function searchModel(fallback: string): string {
  return (process.env.ABACUSAI_BOT_SEARCH_MODEL ?? "").trim() || fallback;
}

/** Cap on provider-side searches per call, so one query can't fan out. */
function maxUses(): number {
  const raw = Number(process.env.ABACUSAI_BOT_SEARCH_MAX_USES);

  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
}

/**
 * The usable value of one credential: the environment's, or the stored one.
 * Read at call time from both, because the environment is frozen at spawn and
 * a session started before sign-in would never see the key sign-in writes.
 * The environment wins when set, as config.ts promises.
 */
const keyFor = (envVar: string): string => {
  const fromEnv = (process.env[envVar] ?? "").trim();

  if (fromEnv.length > 0) return fromEnv;

  const stored = loadConfig().apiKeys?.[envVar];

  return typeof stored === "string" ? stored.trim() : "";
};

// ── Anthropic-compatible ────────────────────────────────────────────────────

interface WebSearchResultItem {
  type?: string;
  url?: unknown;
  title?: unknown;
  page_age?: unknown;
}

interface ContentBlockLike {
  type?: string;
  text?: unknown;
  content?: unknown;
  citations?: unknown;
}

/**
 * Snippets keyed by URL. The searched text lives on the text blocks' citations
 * rather than on the result items, so it has to be joined back by URL.
 */
function snippetsByUrl(blocks: ContentBlockLike[]): Map<string, string> {
  const byUrl = new Map<string, string>();

  for (const block of blocks) {
    if (block.type !== "text" || !Array.isArray(block.citations)) continue;
    for (const citation of block.citations as Array<Record<string, unknown>>) {
      const url = typeof citation.url === "string" ? citation.url : undefined;
      const cited =
        typeof citation.cited_text === "string"
          ? citation.cited_text
          : undefined;
      if (url == null || cited == null) continue;
      const existing = byUrl.get(url);
      byUrl.set(url, existing == null ? cited : `${existing} … ${cited}`);
    }
  }

  return byUrl;
}

/** Exported for the tests: the parser is the part worth pinning per provider. */
export function parseAnthropicBlocks(
  blocks: ContentBlockLike[],
  query: string
): SearchResult {
  const resultBlocks = blocks.filter(
    (block) => block.type === "web_search_tool_result"
  );

  if (resultBlocks.length === 0) {
    // STRICT: the model answered without searching, so any citation in its
    // prose is unverified.
    throw new WebSearchError("NO_RESULTS", noResults);
  }

  const snippets = snippetsByUrl(blocks);
  const sources: SearchSource[] = [];
  const seen = new Set<string>();

  for (const block of resultBlocks) {
    // An error arrives as a single object in place of the list of results.
    if (!Array.isArray(block.content)) {
      const error = block.content as { error_code?: unknown } | undefined;
      const code =
        typeof error?.error_code === "string" ? error.error_code : "unknown";
      throw new WebSearchError("PROVIDER_ERROR", `Search failed: ${code}`);
    }

    for (const item of block.content as WebSearchResultItem[]) {
      const url = typeof item.url === "string" ? item.url : undefined;
      if (url == null || seen.has(url)) continue;
      seen.add(url);
      sources.push({
        url,
        title: typeof item.title === "string" ? item.title : url,
        ...(snippets.has(url) ? { snippet: snippets.get(url) } : {}),
        ...(typeof item.page_age === "string"
          ? { publishedAt: item.page_age }
          : {}),
      });
    }
  }

  if (sources.length === 0) {
    throw new WebSearchError("NO_RESULTS", `No results for "${query}".`);
  }

  const summary = blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => (block.text as string).trim())
    .filter((text) => text.length > 0)
    .join("\n\n");

  return { sources, ...(summary.length > 0 ? { summary } : {}) };
}

/**
 * Anthropic's Messages API, and anything that speaks it. DeepSeek serves the
 * same wire shape down to the `web_search_tool_result` blocks; only the tool
 * version differs, since each vendor accepts the dated variants it shipped.
 */
function anthropicCompatible(spec: {
  id: string;
  envVar: string;
  model: string;
  baseURL?: string;
  toolType: string;
}): Provider {
  return {
    id: spec.id,
    envVar: spec.envVar,
    model: spec.model,
    async run(query, apiKey, options) {
      const client = new Anthropic({
        apiKey,
        ...(spec.baseURL != null ? { baseURL: spec.baseURL } : {}),
      });

      let message: Anthropic.Message;
      try {
        message = await client.messages.create(
          {
            model: searchModel(spec.model),
            max_tokens: 4_096,
            tools: [
              {
                type: spec.toolType,
                name: "web_search",
                max_uses: maxUses(),
              } as unknown as Anthropic.ToolUnion,
            ],
            messages: [{ role: "user", content: prompt(query) }],
          },
          options.signal != null ? { signal: options.signal } : {}
        );
      } catch (error) {
        throw providerFailed(error);
      }

      return parseAnthropicBlocks(
        (message.content ?? []) as unknown as ContentBlockLike[],
        query
      );
    },
  };
}

// ── OpenAI-style url_citation annotations ───────────────────────────────────

interface AnnotationLike {
  type?: string;
  url?: unknown;
  title?: unknown;
  url_citation?: { url?: unknown; title?: unknown; content?: unknown };
}

/**
 * Sources from `url_citation` annotations. OpenAI's Responses API puts the
 * fields on the annotation; OpenRouter nests them under `url_citation`.
 */
export function parseUrlCitations(
  annotations: AnnotationLike[],
  _query: string
): SearchSource[] {
  const sources: SearchSource[] = [];
  const seen = new Set<string>();

  for (const annotation of annotations) {
    if (annotation.type !== "url_citation") continue;
    const nested = annotation.url_citation;
    const url =
      typeof annotation.url === "string"
        ? annotation.url
        : typeof nested?.url === "string"
          ? nested.url
          : undefined;
    if (url == null || seen.has(url)) continue;
    seen.add(url);

    const title =
      typeof annotation.title === "string"
        ? annotation.title
        : typeof nested?.title === "string"
          ? nested.title
          : url;
    // Only OpenRouter carries an excerpt. OpenAI's annotation locates the
    // citation inside the model's own prose, which is not a source excerpt.
    const snippet =
      typeof nested?.content === "string" && nested.content.trim().length > 0
        ? nested.content.trim()
        : undefined;

    sources.push({ url, title, ...(snippet != null ? { snippet } : {}) });
  }

  if (sources.length === 0) throw new WebSearchError("NO_RESULTS", noResults);

  return sources;
}

// ── Gemini grounding ────────────────────────────────────────────────────────

interface GroundingChunk {
  web?: { uri?: unknown; title?: unknown };
}

/**
 * Sources from Gemini's grounding metadata. The URIs are Google redirect links,
 * kept as returned: rewriting a URL the provider vouched for into one it did
 * not is worse than the extra `web_fetch` hop.
 */
export function parseGroundingChunks(
  chunks: GroundingChunk[],
  _query: string
): SearchSource[] {
  const sources: SearchSource[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    const url = typeof chunk.web?.uri === "string" ? chunk.web.uri : undefined;
    if (url == null || seen.has(url)) continue;
    seen.add(url);
    sources.push({
      url,
      title: typeof chunk.web?.title === "string" ? chunk.web.title : url,
    });
  }

  if (sources.length === 0) throw new WebSearchError("NO_RESULTS", noResults);

  return sources;
}

// ── shared plumbing ─────────────────────────────────────────────────────────

const noResults =
  "The provider returned no search results for that query. Nothing was found, " +
  "or the search did not run; either way there are no sources to cite. " +
  "Try a different query; do not cite URLs from memory.";

const providerFailed = (error: unknown): WebSearchError =>
  new WebSearchError(
    "PROVIDER_ERROR",
    `Search provider failed: ${error instanceof Error ? error.message : String(error)}`
  );

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      ...(signal != null ? { signal } : {}),
    });
  } catch (error) {
    throw providerFailed(error);
  }

  if (!response.ok) {
    throw new WebSearchError(
      "PROVIDER_ERROR",
      `Search provider returned ${response.status}.`
    );
  }

  try {
    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    throw providerFailed(error);
  }
}

/** GET counterpart of postJson, for a provider that answers over plain REST. */
async function getJson(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      ...(signal != null ? { signal } : {}),
    });
  } catch (error) {
    throw providerFailed(error);
  }

  if (!response.ok) {
    throw new WebSearchError(
      "PROVIDER_ERROR",
      `Search provider returned ${response.status}.`
    );
  }

  try {
    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    throw providerFailed(error);
  }
}

/**
 * Brave-shaped REST results to sources. Already structured, so the strict rule
 * costs nothing; rows with no URL are dropped.
 */
function braveShaped(body: Record<string, unknown>): SearchSource[] {
  const rows = (body.web as { results?: unknown } | undefined)?.results;
  const list = Array.isArray(rows)
    ? (rows as Array<Record<string, unknown>>)
    : [];

  return list.flatMap((row) => {
    const url = typeof row.url === "string" ? row.url : "";
    if (url.length === 0) return [];

    const title = typeof row.title === "string" ? row.title : "";
    const snippet = typeof row.description === "string" ? row.description : "";

    return [snippet.length > 0 ? { url, title, snippet } : { url, title }];
  });
}

/** RouteLLM's origin: the search proxy hangs off the root, not under /v1. */
const abacusOrigin = (): string => abacusV1BaseUrl().replace(/\/v1$/, "");

/** Text the model wrote, kept apart from the sources it cited. */
const joinText = (parts: Array<unknown>): string | undefined => {
  const text = parts
    .filter((part): part is string => typeof part === "string")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");

  return text.length > 0 ? text : undefined;
};

// ── the providers ───────────────────────────────────────────────────────────

const PROVIDERS: Provider[] = [
  /**
   * Abacus.AI first: the subscription the user already pays for, answering
   * over REST with no model turn. The proxy is a drop-in for
   * api.search.brave.com, so the response is Brave's shape.
   */
  {
    id: "abacus",
    envVar: "ABACUS_API_KEY",
    async run(query, apiKey, options) {
      const body = await getJson(
        `${abacusOrigin()}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${options.maxResults}`,
        { authorization: `Bearer ${apiKey}` },
        options.signal
      );

      return { sources: braveShaped(body) };
    },
  },
  anthropicCompatible({
    id: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    model: "claude-opus-5",
    // This dated variant filters results provider-side before returning them.
    toolType: "web_search_20260209",
  }),
  anthropicCompatible({
    id: "deepseek",
    envVar: "DEEPSEEK_API_KEY",
    model: "deepseek-v4-flash",
    // Not $DEEPSEEK_BASE_URL, which is the chat-completions host. The SDK
    // appends /v1/messages.
    baseURL: "https://api.deepseek.com/anthropic",
    toolType: "web_search_20250305",
  }),
  {
    id: "openai",
    envVar: "OPENAI_API_KEY",
    model: "gpt-5.6-sol",
    async run(query, apiKey, options) {
      const body = await postJson(
        "https://api.openai.com/v1/responses",
        { authorization: `Bearer ${apiKey}` },
        {
          model: searchModel("gpt-5.6-sol"),
          tools: [{ type: "web_search" }],
          input: prompt(query),
        },
        options.signal
      );

      const output = Array.isArray(body.output)
        ? (body.output as Array<Record<string, unknown>>)
        : [];
      const content = output
        .filter((item) => item.type === "message")
        .flatMap((item) =>
          Array.isArray(item.content)
            ? (item.content as Array<Record<string, unknown>>)
            : []
        );
      const annotations = content.flatMap((part) =>
        Array.isArray(part.annotations)
          ? (part.annotations as AnnotationLike[])
          : []
      );

      const summary = joinText(content.map((part) => part.text));

      return {
        sources: parseUrlCitations(annotations, query),
        ...(summary != null ? { summary } : {}),
      };
    },
  },
  {
    id: "gemini",
    envVar: "GEMINI_API_KEY",
    model: "gemini-3.6-flash",
    async run(query, apiKey, options) {
      const model = searchModel("gemini-3.6-flash");
      const body = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { "x-goog-api-key": apiKey },
        {
          contents: [{ parts: [{ text: prompt(query) }] }],
          tools: [{ google_search: {} }],
        },
        options.signal
      );

      const candidates = Array.isArray(body.candidates)
        ? (body.candidates as Array<Record<string, unknown>>)
        : [];
      const first = candidates[0] ?? {};
      const grounding = first.groundingMetadata as
        | { groundingChunks?: unknown }
        | undefined;
      const chunks = Array.isArray(grounding?.groundingChunks)
        ? (grounding.groundingChunks as GroundingChunk[])
        : [];
      const parts = ((first.content as { parts?: unknown } | undefined)
        ?.parts ?? []) as Array<Record<string, unknown>>;

      const summary = joinText(
        Array.isArray(parts) ? parts.map((part) => part.text) : []
      );

      return {
        sources: parseGroundingChunks(chunks, query),
        ...(summary != null ? { summary } : {}),
      };
    },
  },
  {
    id: "openrouter",
    envVar: "OPENROUTER_API_KEY",
    model: "openai/gpt-oss-20b",
    async run(query, apiKey, options) {
      const body = await postJson(
        "https://openrouter.ai/api/v1/chat/completions",
        { authorization: `Bearer ${apiKey}` },
        {
          model: searchModel("openai/gpt-oss-20b"),
          // The `web` plugin rather than `:online`: it composes with a model
          // slug that already carries a variant.
          plugins: [{ id: "web", max_results: options.maxResults }],
          messages: [{ role: "user", content: prompt(query) }],
        },
        options.signal
      );

      const choices = Array.isArray(body.choices)
        ? (body.choices as Array<Record<string, unknown>>)
        : [];
      const message = (choices[0]?.message ?? {}) as Record<string, unknown>;
      const annotations = Array.isArray(message.annotations)
        ? (message.annotations as AnnotationLike[])
        : [];
      const summary = joinText([message.content]);

      return {
        sources: parseUrlCitations(annotations, query),
        ...(summary != null ? { summary } : {}),
      };
    },
  },
];

/**
 * Which providers can search, first configured first in the order above so a
 * user holding several keys gets a stable answer. ABACUSAI_BOT_SEARCH_PROVIDER
 * picks one by id.
 */
export function usableProviders(): Provider[] {
  const wanted = (process.env.ABACUSAI_BOT_SEARCH_PROVIDER ?? "").trim();
  const configured = PROVIDERS.filter(
    (provider) => keyFor(provider.envVar).length > 0
  );

  return wanted.length > 0
    ? configured.filter((provider) => provider.id === wanted)
    : configured;
}

export function resolveProvider(): Provider | undefined {
  return usableProviders()[0];
}

/**
 * Whether a search provider is reachable. Read at call time so a key added in
 * Settings works on the next call, not the next launch.
 */
export function searchAvailable(): boolean {
  return resolveProvider() != null;
}

/**
 * Whether the desktop serves `x_search` itself, over the platform's X API
 * (this process cannot read the app's settings). Then X search here stands
 * down: X's own index beats a web index filtered to x.com.
 */
export function desktopXSearchAvailable(): boolean {
  return (process.env.ABACUSAI_BOT_DESKTOP_X_SEARCH ?? "").trim() === "1";
}

/**
 * Whether a source actually came from one of `hosts`. Compared on the parsed
 * host, never the URL string (`https://evil.example/x.com/post`). Subdomains
 * count; a bare suffix match does not, so `notx.com` cannot pass as `x.com`.
 */
function fromHost(url: string, hosts: readonly string[]): boolean {
  let host: string;

  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }

  return hosts.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`)
  );
}

export async function search(
  query: string,
  options: {
    maxResults?: number;
    signal?: AbortSignal;
    sites?: readonly string[];
  } = {}
): Promise<SearchResult> {
  const usable = usableProviders();

  if (usable.length === 0) {
    throw new WebSearchError(
      "NO_PROVIDER",
      "Web search needs an API key. It reuses whichever one the app already uses " +
        "for models: an Abacus subscription, Claude, DeepSeek, OpenAI, Gemini or " +
        "OpenRouter all work, so adding one in Settings starts search too; there " +
        "is no separate search signup."
    );
  }

  const limit = Math.max(1, options.maxResults ?? 10);
  const sites = options.sites ?? [];
  // Some providers ignore `site:` entirely, so the operator is a hint and the
  // filter below is the actual guarantee.
  const scoped =
    sites.length > 0
      ? `${query} ${sites.map((site) => `site:${site}`).join(" OR ")}`
      : query;

  // One failing provider should not fail the call while another key sits idle.
  // A single provider's error is rethrown untouched so its guidance survives.
  const failures: string[] = [];

  for (const provider of usable) {
    try {
      const result = await provider.run(scoped, keyFor(provider.envVar), {
        maxResults: limit,
        ...(options.signal != null ? { signal: options.signal } : {}),
      });

      const sources =
        sites.length > 0
          ? result.sources.filter((source) => fromHost(source.url, sites))
          : result.sources;

      if (sites.length > 0 && sources.length === 0) {
        throw new WebSearchError(
          "NO_RESULTS",
          `The search returned nothing from ${sites.join(" or ")}. Say so rather than ` +
            "answering from memory: results from elsewhere were discarded, not hidden."
        );
      }

      return { ...result, sources: sources.slice(0, limit) };
    } catch (error) {
      if (usable.length === 1) throw error;

      failures.push(
        `${provider.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  throw new WebSearchError(
    "PROVIDER_ERROR",
    `Every configured search provider failed. ${failures.join("; ")}`
  );
}
