import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
const apiCall = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, result: null }))
);

vi.mock("../config/settings", () => ({
  hasCredential: () => true,
  credentialFor: (name: string) =>
    name === "ABACUS_API_KEY" ? "test-key" : "",
}));
vi.mock("./abacus-host", () => ({
  abacusRoutellmV1: () => "https://routellm.example/v1",
  abacusUserAgent: () => "test-agent",
}));
vi.mock("./abacus-connector-service", () => ({ abacusApiCall: apiCall }));
vi.stubGlobal("fetch", fetchMock);

const { cachedAbacusAccount, clearAbacusCache, fetchAbacusAccount } =
  await import("./abacus");
const { takeWebsitePrompt } = await import("./website-prompt");

const account = (body: Record<string, unknown>) =>
  new Response(JSON.stringify({ subscription_tier: "free", ...body }), {
    status: 200,
  });

beforeEach(() => {
  fetchMock.mockReset();
  apiCall.mockClear();
  clearAbacusCache();
});

describe("the website's prompt on the account", () => {
  it.each<[unknown, string | undefined]>([
    ["Build a site for my bakery", "Build a site for my bakery"],
    ["  spaced  ", "spaced"],
    ["   ", undefined],
    [null, undefined],
    [7, undefined],
    [undefined, undefined],
  ])("%j reads as %j", async (sent, read) => {
    fetchMock.mockResolvedValueOnce(account({ website_prompt: sent }));
    const value = await fetchAbacusAccount(true);
    expect(value?.website_prompt).toBe(read);
    expect(value != null && "website_prompt" in value).toBe(read != null);
  });

  it("is let go of once taken: the cache drops it and the platform is told", async () => {
    fetchMock.mockResolvedValueOnce(account({ website_prompt: "Make a game" }));
    await fetchAbacusAccount(true);
    takeWebsitePrompt();
    expect(cachedAbacusAccount()?.website_prompt).toBeUndefined();
    expect(cachedAbacusAccount()?.subscription_tier).toBe("free");
    expect(apiCall).toHaveBeenCalledWith(
      "_ackAbacusbotFirstPrompt",
      "POST",
      {},
      10_000
    );
  });
});
