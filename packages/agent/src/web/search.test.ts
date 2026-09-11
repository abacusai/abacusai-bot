/**
 * Search has one rule worth defending in a test: it must never present model
 * prose as if it were search results.
 *
 * A model that did not search will happily write four plausible-looking URLs,
 * and nothing downstream can tell those from real ones. So the provider is
 * stubbed here to return the shapes a real one can return — including the one
 * where it answers without searching — and the assertion is that the last case
 * fails loudly rather than quietly.
 *
 * The provider is stubbed rather than called: a suite that needs a funded API
 * key and a network is a suite people learn to skip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

/** Every key that can select a provider — cleared together, or a developer
 * with one exported in their shell gets a different suite than CI. */
const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
];

const clearKeys = (): void => {
  for (const name of PROVIDER_KEYS) delete process.env[name];
  delete process.env.ABACUSAI_BOT_SEARCH_PROVIDER;
};

let search: typeof import("./search.js").search;
let searchAvailable: typeof import("./search.js").searchAvailable;
let resolveProvider: typeof import("./search.js").resolveProvider;
let WebSearchError: typeof import("./search.js").WebSearchError;

beforeEach(async () => {
  create.mockReset();
  clearKeys();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
  const module = await import("./search.js");
  search = module.search;
  searchAvailable = module.searchAvailable;
  resolveProvider = module.resolveProvider;
  WebSearchError = module.WebSearchError;
});

afterEach(() => {
  // Every one of them: a provider id or a stray key left behind here silently
  // re-points every later test at a provider it never meant to select.
  clearKeys();
  delete process.env.ABACUSAI_BOT_SEARCH_MODEL;
});

/** A response carrying real, structured results. */
function withResults() {
  return {
    content: [
      {
        type: "web_search_tool_result",
        content: [
          {
            type: "web_search_result",
            url: "https://a.test/1",
            title: "First",
            page_age: "2 days ago",
          },
          {
            type: "web_search_result",
            url: "https://b.test/2",
            title: "Second",
          },
        ],
      },
      {
        type: "text",
        text: "Both sources agree.",
        citations: [
          { url: "https://a.test/1", cited_text: "the relevant sentence" },
        ],
      },
    ],
  };
}

describe("availability", () => {
  it("is available on the key the app already uses for models", () => {
    expect(searchAvailable()).toBe(true);
  });

  it("is unavailable with no key, rather than failing at call time", () => {
    clearKeys();
    expect(searchAvailable()).toBe(false);
  });

  it("explains that the model key is the search key", async () => {
    clearKeys();
    const error = await search("anything").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebSearchError);
    expect((error as InstanceType<typeof WebSearchError>).code).toBe(
      "NO_PROVIDER"
    );
    // The whole selling point: there is no separate search signup.
    expect((error as Error).message).toMatch(
      /reuses whichever one the app already/
    );
  });

  it("runs on any model key, not only the Claude one", () => {
    // The reason this matters: a DeepSeek or Gemini user was told search was
    // unconfigured while holding a key that can run it.
    for (const name of PROVIDER_KEYS) {
      clearKeys();
      process.env[name] = "test-key";
      expect(searchAvailable(), `${name} should select a provider`).toBe(true);
    }
  });

  it("picks one provider deterministically when several keys are present", () => {
    clearKeys();
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.DEEPSEEK_API_KEY = "test-key";
    process.env.ANTHROPIC_API_KEY = "test-key";
    expect(resolveProvider()?.id).toBe("anthropic");

    delete process.env.ANTHROPIC_API_KEY;
    expect(resolveProvider()?.id).toBe("deepseek");
  });

  it("lets the choice be overridden by id, and refuses an unkeyed one", () => {
    clearKeys();
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.GEMINI_API_KEY = "test-key";

    process.env.ABACUSAI_BOT_SEARCH_PROVIDER = "gemini";
    expect(resolveProvider()?.id).toBe("gemini");

    delete process.env.GEMINI_API_KEY;
    expect(resolveProvider()).toBeUndefined();
  });
});

describe("strict mode", () => {
  it("fails when the provider answered without searching", async () => {
    // No web_search_tool_result block. The prose may look like an answer with
    // citations; it is not, and passing it off as one is how hallucinated
    // sources reach the user.
    create.mockResolvedValue({
      content: [
        {
          type: "text",
          text: "According to https://plausible.test/article, the answer is 42.",
        },
      ],
    });

    const error = await search("what is the answer").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebSearchError);
    expect((error as InstanceType<typeof WebSearchError>).code).toBe(
      "NO_RESULTS"
    );
  });

  it("does not leak the URL from that prose into the failure", async () => {
    create.mockResolvedValue({
      content: [
        {
          type: "text",
          text: "See https://plausible.test/article for details.",
        },
      ],
    });

    const error = (await search("q").catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain("plausible.test");
  });

  it("tells the model not to cite from memory instead", async () => {
    create.mockResolvedValue({
      content: [{ type: "text", text: "no search here" }],
    });
    const error = (await search("q").catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/do not cite URLs from memory/i);
  });

  it("surfaces a provider-side error rather than treating it as empty", async () => {
    create.mockResolvedValue({
      content: [
        {
          type: "web_search_tool_result",
          content: { error_code: "max_uses_exceeded" },
        },
      ],
    });

    const error = (await search("q").catch((e: unknown) => e)) as InstanceType<
      typeof WebSearchError
    >;
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("max_uses_exceeded");
  });

  it("reports a transport failure as a provider error", async () => {
    create.mockRejectedValue(new Error("connection reset"));
    const error = (await search("q").catch((e: unknown) => e)) as InstanceType<
      typeof WebSearchError
    >;
    expect(error.code).toBe("PROVIDER_ERROR");
  });
});

describe("reading real results", () => {
  it("returns the structured sources", async () => {
    create.mockResolvedValue(withResults());
    const result = await search("a query");

    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]).toMatchObject({
      url: "https://a.test/1",
      title: "First",
    });
  });

  it("joins each snippet back to its source by URL", async () => {
    // The excerpts live on the text block's citations, not on the result
    // items, so they have to be matched up.
    create.mockResolvedValue(withResults());
    const result = await search("a query");

    expect(result.sources[0]!.snippet).toBe("the relevant sentence");
    expect(result.sources[1]!.snippet).toBeUndefined();
  });

  it("carries the publication date when the provider gave one", async () => {
    create.mockResolvedValue(withResults());
    const result = await search("a query");
    expect(result.sources[0]!.publishedAt).toBe("2 days ago");
  });

  it("keeps the summary separate from the sources", async () => {
    create.mockResolvedValue(withResults());
    const result = await search("a query");
    expect(result.summary).toBe("Both sources agree.");
  });

  it("drops duplicate URLs across result blocks", async () => {
    create.mockResolvedValue({
      content: [
        {
          type: "web_search_tool_result",
          content: [
            { type: "web_search_result", url: "https://a.test/1", title: "A" },
          ],
        },
        {
          type: "web_search_tool_result",
          content: [
            {
              type: "web_search_result",
              url: "https://a.test/1",
              title: "A again",
            },
          ],
        },
      ],
    });

    const result = await search("a query");
    expect(result.sources).toHaveLength(1);
  });

  it("honours the caller cap on how many sources come back", async () => {
    create.mockResolvedValue({
      content: [
        {
          type: "web_search_tool_result",
          content: Array.from({ length: 20 }, (_, i) => ({
            type: "web_search_result",
            url: `https://a.test/${i}`,
            title: `Result ${i}`,
          })),
        },
      ],
    });

    const result = await search("a query", { maxResults: 3 });
    expect(result.sources).toHaveLength(3);
  });

  it("fails when the block is present but empty", async () => {
    create.mockResolvedValue({
      content: [{ type: "web_search_tool_result", content: [] }],
    });
    const error = (await search("q").catch((e: unknown) => e)) as InstanceType<
      typeof WebSearchError
    >;
    expect(error.code).toBe("NO_RESULTS");
  });
});

describe("the backend model", () => {
  it("asks the provider for its server-side search tool", async () => {
    create.mockResolvedValue(withResults());
    await search("a query");

    const request = create.mock.calls[0]![0] as {
      tools: Array<{ type: string; name: string }>;
    };
    expect(request.tools[0]!.name).toBe("web_search");
    // The dated variant is the contract with the provider, not a version we
    // invented — pinning it here makes an accidental change visible.
    expect(request.tools[0]!.type).toBe("web_search_20260209");
  });

  it("can be pointed at a cheaper model without touching the session model", async () => {
    process.env.ABACUSAI_BOT_SEARCH_MODEL = "claude-haiku-4-5";
    vi.resetModules();
    const { search: reloaded } = await import("./search.js");
    create.mockResolvedValue(withResults());

    await reloaded("a query");

    const request = create.mock.calls[0]![0] as { model: string };
    expect(request.model).toBe("claude-haiku-4-5");
  });
});

/**
 * The other providers, at the seam that can be tested without a key.
 *
 * Each one is a request and a parser. The request is a URL and a body — wrong
 * and it fails loudly on the first real call — while the parser is where a
 * shape change turns into silently missing sources, or worse, into prose
 * presented as citations. So the parsers are pinned against the shapes the
 * vendors document, including the empty case that strict mode has to refuse.
 */
describe("OpenAI-style url_citation annotations", () => {
  let parseUrlCitations: typeof import("./search.js").parseUrlCitations;

  beforeEach(async () => {
    parseUrlCitations = (await import("./search.js")).parseUrlCitations;
  });

  it("reads the flat shape the Responses API returns", () => {
    const sources = parseUrlCitations(
      [
        { type: "url_citation", url: "https://a.test/1", title: "First" },
        { type: "output_text" },
      ],
      "q"
    );

    expect(sources).toEqual([{ url: "https://a.test/1", title: "First" }]);
  });

  it("reads the nested shape OpenRouter returns, excerpt included", () => {
    const sources = parseUrlCitations(
      [
        {
          type: "url_citation",
          url_citation: {
            url: "https://b.test/2",
            title: "Second",
            content: "an excerpt",
          },
        },
      ],
      "q"
    );

    expect(sources).toEqual([
      { url: "https://b.test/2", title: "Second", snippet: "an excerpt" },
    ]);
  });

  it("drops duplicates and falls back to the URL for a missing title", () => {
    const sources = parseUrlCitations(
      [
        { type: "url_citation", url: "https://a.test/1" },
        { type: "url_citation", url: "https://a.test/1", title: "Same page" },
      ],
      "q"
    );

    expect(sources).toEqual([
      { url: "https://a.test/1", title: "https://a.test/1" },
    ]);
  });

  it("refuses a response that cited nothing", () => {
    // The model answered without searching. Strict mode: no sources, no result.
    expect(() => parseUrlCitations([{ type: "output_text" }], "q")).toThrow(
      /do not cite URLs from memory/i
    );
  });
});

describe("Gemini grounding chunks", () => {
  let parseGroundingChunks: typeof import("./search.js").parseGroundingChunks;

  beforeEach(async () => {
    parseGroundingChunks = (await import("./search.js")).parseGroundingChunks;
  });

  it("reads the web chunks", () => {
    const sources = parseGroundingChunks(
      [
        {
          web: {
            uri: "https://vertexaisearch.test/redirect/abc",
            title: "a.test",
          },
        },
        {
          web: {
            uri: "https://vertexaisearch.test/redirect/def",
            title: "b.test",
          },
        },
      ],
      "q"
    );

    expect(sources).toHaveLength(2);
    expect(sources[0]).toEqual({
      url: "https://vertexaisearch.test/redirect/abc",
      title: "a.test",
    });
  });

  it("ignores a chunk with no web source", () => {
    const sources = parseGroundingChunks(
      [
        {},
        { web: { title: "no uri" } },
        { web: { uri: "https://a.test/1", title: "Real" } },
      ],
      "q"
    );

    expect(sources).toEqual([{ url: "https://a.test/1", title: "Real" }]);
  });

  it("refuses a response that was not grounded", () => {
    expect(() => parseGroundingChunks([], "q")).toThrow(
      /do not cite URLs from memory/i
    );
  });
});

describe("scoping a search to a set of sites", () => {
  /** A result set mixing the wanted domain with everything else. */
  function mixed() {
    return {
      content: [
        {
          type: "web_search_tool_result",
          content: [
            {
              type: "web_search_result",
              url: "https://x.com/someone/status/1",
              title: "A post",
            },
            {
              type: "web_search_result",
              url: "https://mobile.twitter.com/b/status/2",
              title: "Another",
            },
            {
              type: "web_search_result",
              url: "https://techblog.test/about-x",
              title: "Coverage of X",
            },
          ],
        },
      ],
    };
  }

  it("asks the provider for the scope", async () => {
    create.mockResolvedValue(mixed());
    await search("agents", { sites: ["x.com", "twitter.com"] });

    const sent = JSON.stringify(create.mock.calls.at(-1));

    expect(sent).toContain("site:x.com");
    expect(sent).toContain("agents");
  });

  it("drops what came from anywhere else", async () => {
    // The `site:` operator is a request, and providers are free to ignore it.
    // Enforcing it here is what makes the scope a guarantee rather than a hope
    // — otherwise "search X" quietly returns a blog's coverage of X.
    create.mockResolvedValue(mixed());
    const result = await search("agents", { sites: ["x.com", "twitter.com"] });

    expect(result.sources.map((source) => source.url)).toEqual([
      "https://x.com/someone/status/1",
      "https://mobile.twitter.com/b/status/2",
    ]);
  });

  it("accepts subdomains but not lookalike domains", async () => {
    create.mockResolvedValue({
      content: [
        {
          type: "web_search_tool_result",
          content: [
            {
              type: "web_search_result",
              url: "https://mobile.x.com/a/1",
              title: "Subdomain",
            },
            {
              type: "web_search_result",
              url: "https://notx.com/a/2",
              title: "Lookalike",
            },
            {
              type: "web_search_result",
              url: "https://evil.test/x.com/a/3",
              title: "In the path",
            },
          ],
        },
      ],
    });

    const result = await search("agents", { sites: ["x.com"] });

    // Compared on the parsed host: a suffix match would admit `notx.com`, and a
    // substring match would admit any URL with the domain sitting in its path.
    expect(result.sources.map((source) => source.url)).toEqual([
      "https://mobile.x.com/a/1",
    ]);
  });

  it("fails loudly when the scope leaves nothing", async () => {
    // Silently returning zero sources reads as "X has nothing to say about
    // this", when what happened is that the provider ignored the scope.
    create.mockResolvedValue({
      content: [
        {
          type: "web_search_tool_result",
          content: [
            {
              type: "web_search_result",
              url: "https://techblog.test/a",
              title: "Coverage",
            },
          ],
        },
      ],
    });

    await expect(search("agents", { sites: ["x.com"] })).rejects.toThrow(
      /x\.com/
    );
  });

  it("leaves an unscoped search alone", async () => {
    create.mockResolvedValue(withResults());
    const result = await search("a query");

    expect(result.sources).toHaveLength(2);
  });
});
