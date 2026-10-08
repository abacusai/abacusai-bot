import { contract } from "@abacus-ai/contract/contract";
import type { ModelAvailability } from "@abacus-ai/contract/models";
import { implement } from "@orpc/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Transport } from "#renderer/data/transport";
import { createHarness } from "#renderer/test-support/app-harness";

import { useModelSetup } from "./use-model-setup";

const mocked = vi.hoisted(() => ({
  context: {} as { transport: Transport; credentialsChanged(): Promise<void> },
  desktop: true,
  navigate: vi.fn(),
}));
vi.mock("#renderer/lib/use-app-context", () => ({
  useAppContext: () => mocked.context,
}));
vi.mock("#renderer/lib/navigation/use-app-navigate", () => ({
  useAppNavigate: () => mocked.navigate,
}));
vi.mock("#renderer/lib/platform", () => ({
  get IS_ELECTRON() {
    return mocked.desktop;
  },
  get IS_BROWSER() {
    return !mocked.desktop;
  },
}));
const signIn = vi.hoisted(() => vi.fn());
vi.mock("#platform/sign-in", () => ({ signInAbacus: signIn }));
let harness: Awaited<ReturnType<typeof createHarness>>;
let cache: QueryClient;
let catalog: ModelAvailability[] = [];
const modelList = vi.fn();
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={cache}>{children}</QueryClientProvider>
);
beforeEach(async () => {
  mocked.desktop = true;
  mocked.navigate.mockClear();
  signIn.mockReset();
  catalog = [];
  modelList.mockClear();
  harness = await createHarness("/sessions/new", {
    procedures: {
      models: {
        list: implement(contract).models.list.handler(({ input }) => {
          modelList(input);
          return catalog;
        }),
      },
    },
  });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocked.context = {
    transport: harness.transport,
    credentialsChanged: vi.fn(async () => {}),
  };
});
afterEach(async () => {
  cache.clear();
  await harness.cleanup();
});
const empty = {
  models: [] as ModelAvailability[],
  loading: false,
  failed: false,
  select: vi.fn(),
};

describe("provider setup actions", () => {
  it.each([true, false])(
    "offers the supported registry paths on desktop=%s",
    async (desktop) => {
      mocked.desktop = desktop;
      const view = renderHook(() => useModelSetup(empty), { wrapper });
      await waitFor(() => expect(cache.isFetching()).toBe(0));
      expect(view.result.current.providers.map((p) => p.id)).toEqual([
        "abacus",
        "openrouter",
        "openai",
        "anthropic",
        "gemini",
      ]);
      expect(
        view.result.current.providers.find((p) => p.id === "openrouter")
          ?.connect
      ).toBe(desktop);
      expect(
        view.result.current.providers.find((p) => p.id === "abacus")?.connect
      ).toBe(true);
      expect(view.result.current.localAvailable).toBe(false);
    }
  );

  it("refreshes and selects the first configured model after connecting", async () => {
    const select = vi.fn();
    const models: ModelAvailability[] = [
      {
        id: "openai/locked",
        label: "Unavailable",
        provider: "openai",
        tier: "strong",
        configured: false,
      },
      {
        id: "openai/ready",
        label: "Ready",
        provider: "openai",
        tier: "default",
        configured: true,
      },
    ];
    catalog = models;
    signIn.mockResolvedValue({ ok: true });
    const view = renderHook(() => useModelSetup({ ...empty, select }), {
      wrapper,
    });
    await act(async () => {
      expect(await view.result.current.connect("abacus")).toBe(true);
    });
    expect(modelList).toHaveBeenCalledWith({ refresh: true });
    expect(select).toHaveBeenCalledWith("openai/ready");
    expect(mocked.context.credentialsChanged).toHaveBeenCalled();
  });

  it("does not refresh or claim success when sign-in is cancelled", async () => {
    signIn.mockResolvedValue({ ok: false, cancelled: true });
    const view = renderHook(() => useModelSetup(empty), { wrapper });
    expect(await view.result.current.connect("abacus")).toBe(false);
    expect(mocked.context.credentialsChanged).not.toHaveBeenCalled();
  });
});
