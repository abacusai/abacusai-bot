/**
 * The Usage panel's data path, from the main process side.
 *
 * The scan itself is covered in the agent package; what matters here is that
 * the OpenRouter lookup stays one network call. The panel refetches on every
 * open and every focus, and more than one window can ask at once.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchOpenRouterKeyStatus = vi.fn();
const summary = vi.fn();

vi.mock("@abacus-ai/agent/usage", () => ({
  fetchOpenRouterKeyStatus,
  UsageScanner: class {
    summary = summary;
  },
}));

vi.mock("../config/settings", () => ({
  readSettings: () => ({ apiKeys: { OPENROUTER_API_KEY: "test-key" } }),
}));

vi.mock("../../paths", () => ({
  abacusBotHome: () => "/nowhere",
}));

const { getUsageSnapshot, resetUsageService } = await import("./usage");

const emptySummary = {
  generatedAt: 0,
  days: 30,
  totals: {
    requests: 0,
    errors: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  },
  today: {
    requests: 0,
    errors: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  },
  models: [],
  daily: [],
  unpriced: false,
};

const status = { usage: 1, limit: null, isFreeTier: true };

beforeEach(() => {
  resetUsageService();
  fetchOpenRouterKeyStatus.mockReset();
  summary.mockReset();
  summary.mockResolvedValue(emptySummary);
  delete process.env.OPENROUTER_API_KEY;
});

describe("the OpenRouter key status", () => {
  it("makes one request when two panels ask at once", async () => {
    let release: (value: typeof status) => void = () => undefined;

    fetchOpenRouterKeyStatus.mockReturnValue(
      new Promise<typeof status>((resolve) => {
        release = resolve;
      })
    );

    const both = Promise.all([getUsageSnapshot(), getUsageSnapshot()]);

    release(status);

    const [first, second] = await both;

    expect(fetchOpenRouterKeyStatus).toHaveBeenCalledTimes(1);
    expect(first?.openrouter).toEqual(status);
    expect(second?.openrouter).toEqual(status);
  });

  it("serves the cached answer to the next caller", async () => {
    fetchOpenRouterKeyStatus.mockResolvedValue(status);

    await getUsageSnapshot();
    await getUsageSnapshot();

    expect(fetchOpenRouterKeyStatus).toHaveBeenCalledTimes(1);
  });

  it("starts the cache clock when the answer arrives, not when it was asked for", async () => {
    let clock = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    let release: (value: typeof status) => void = () => undefined;

    fetchOpenRouterKeyStatus.mockReturnValue(
      new Promise<typeof status>((resolve) => {
        release = resolve;
      })
    );

    try {
      const first = getUsageSnapshot();

      await vi.waitFor(() =>
        expect(fetchOpenRouterKeyStatus).toHaveBeenCalled()
      );

      // A slow request: issued at 0, answered a full TTL later. Stamped at the
      // time it was issued it would be expired the moment it landed.
      clock = 61_000;
      release(status);
      await first;

      clock = 61_500;
      await getUsageSnapshot();

      expect(fetchOpenRouterKeyStatus).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });
});
