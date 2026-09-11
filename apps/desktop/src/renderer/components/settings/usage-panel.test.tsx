/**
 * The Usage panel's honesty about money.
 *
 * The numbers come from the scanner; what this file pins is how the panel is
 * allowed to render them. A row the router runs for free and a row nobody
 * published a price for both arrive with cost 0, and printing "$0" on either
 * would tell the user something the logs never said.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The panel renders translated strings; the keys are what the assertions read.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import type {
  ModelUsageStats,
  UsageSnapshot,
  UsageTotals,
} from "#shared/contracts";

const { UsagePanel } = await import("./usage-panel");

const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({
  requests: 0,
  errors: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  ...over,
});

const model = (over: Partial<ModelUsageStats>): ModelUsageStats => ({
  ...totals({ requests: 3, input: 900, output: 100, cost: 1.5 }),
  id: "anthropic/claude-opus-5",
  provider: "anthropic",
  modelId: "claude-opus-5",
  pool: false,
  billing: "billed",
  today: totals(),
  lastUsed: 0,
  ...over,
});

const snapshot = (over: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  generatedAt: Date.UTC(2026, 7, 20, 12),
  days: 30,
  totals: totals({ requests: 3, cost: 1.5 }),
  today: totals(),
  models: [model({})],
  daily: [],
  unpriced: false,
  openrouter: null,
  ...over,
});

const byId = (id: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (node == null) throw new Error(`no element with data-id="${id}"`);

  return node;
};

const mount = async (value: UsageSnapshot): Promise<void> => {
  (globalThis.window as unknown as { api: unknown }).api = {
    agent: { getUsageSnapshot: async () => value },
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    (
      <QueryClientProvider client={client}>
        <UsagePanel />
      </QueryClientProvider>
    ) as JSX.Element
  );
  await waitFor(() => byId("usage-panel"));
};

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("what a row's dollar column says", () => {
  it("prints a real price for a billed model", async () => {
    await mount(snapshot());

    await waitFor(() =>
      expect(byId("usage-model-cost").textContent).toBe("$1.50")
    );
  });

  it("prints no amount for a model the router runs for free", async () => {
    await mount(
      snapshot({
        models: [
          model({
            id: "gemini/gemini-3.6-flash",
            provider: "gemini",
            modelId: "gemini-3.6-flash",
            pool: true,
            billing: "free",
          }),
        ],
      })
    );

    await waitFor(() =>
      expect(byId("usage-model-cost").textContent).toBe("usage.notBilled")
    );
  });

  it("prints no amount for a model with no published price", async () => {
    await mount(
      snapshot({
        unpriced: true,
        models: [model({ billing: "unknown", cost: 0 })],
      })
    );

    await waitFor(() =>
      expect(byId("usage-model-cost").textContent).toBe("usage.priceUnknown")
    );
    // And the total says out loud that it is a floor.
    expect(byId("usage-unpriced")).toBeDefined();
  });

  it("leaves the hint off when every price is known", async () => {
    await mount(snapshot());

    await waitFor(() => byId("usage-card-window"));
    expect(document.querySelector('[data-id="usage-unpriced"]')).toBeNull();
  });
});

describe("negative amounts", () => {
  it("shows a credit as a credit, not as a fraction of a cent", async () => {
    await mount(
      snapshot({
        totals: totals({ requests: 3, cost: -0.004 }),
        today: totals({ requests: 1, cost: -2.5 }),
      })
    );

    await waitFor(() =>
      expect(byId("usage-card-window").textContent).toContain(">-$0.01")
    );
    expect(byId("usage-card-today").textContent).toContain("-$2.50");
  });
});
