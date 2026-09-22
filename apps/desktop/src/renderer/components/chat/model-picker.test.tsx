import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelAvailability } from "#shared/models";

import { ModelPicker } from "./model-picker";

const navigate = vi.fn();
const openExternal = vi.fn(async () => {});
const toggleFavoriteModel = vi.fn();
let favoriteModelIds: string[] = [];

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "workspace.modelPicker.addFavorite": "Add to favorites",
        "workspace.modelPicker.configure": "Configure",
        "workspace.modelPicker.configureProviders": "Configure model providers",
        "workspace.modelPicker.connectModels": "Connect models",
        "workspace.modelPicker.favorites": "Favorites",
        "workspace.modelPicker.noFavorites": "No favorites",
        "workspace.modelPicker.noResults": "No models found",
        "workspace.modelPicker.removeFavorite": "Remove from favorites",
        "workspace.modelPicker.search": "Search models",
        "workspace.modelPlaceholder": "Model",
        "workspace.refreshModels": "Refresh models",
      })[key] ?? key,
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

vi.mock("../../stores/code-store", () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) =>
    selector({
      favoriteModelIds,
      toggleFavoriteModel,
    }),
}));

const configuredModel: ModelAvailability = {
  id: "openai/gpt-5.6",
  label: "GPT-5.6",
  provider: "openai",
  tier: "strong",
  configured: true,
};

const unconfiguredModel: ModelAvailability = {
  id: "anthropic/claude-sonnet-5",
  label: "Claude Sonnet 5",
  provider: "anthropic",
  tier: "strong",
  configured: false,
};

const renderPicker = (models: ModelAvailability[]) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ModelPicker
        models={models}
        selectedModelValue={configuredModel.id}
        activeWorkspaceId="workspace-one"
        onSelectModel={vi.fn()}
      />
    </QueryClientProvider>
  );

beforeEach(() => {
  favoriteModelIds = [];
  navigate.mockClear();
  // The free-tier connect rows read the signed-in account; a signed-out
  // answer keeps the existing expectations exact.
  openExternal.mockClear();
  (globalThis.window as unknown as { api: unknown }).api = {
    agent: { getAbacusAccount: async () => null },
    openExternal,
  };
});

describe("ModelPicker", () => {
  it("groups the models served on this machine under their own name", async () => {
    const local: ModelAvailability = {
      id: "local/qwen3.5-4b",
      label: "Qwen 3.5 4B",
      provider: "local",
      tier: "local",
      configured: true,
    };
    renderPicker([configuredModel, local]);
    fireEvent.click(screen.getByRole("combobox"));

    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-id="local-code-model-option-local/qwen3.5-4b"]'
        )
      ).not.toBeNull()
    );
    expect(screen.getByText("localModels.onThisMachine")).toBeTruthy();
  });

  it("replaces the picker with the shared provider launcher when no model is configured", () => {
    renderPicker([unconfiguredModel]);

    fireEvent.click(screen.getByRole("button", { name: "Connect models" }));

    expect(navigate).toHaveBeenCalledWith({
      to: "/settings/models",
      search: {},
    });
    expect(
      screen.queryByRole("button", { name: "Configure model providers" })
    ).toBeNull();
  });

  it("shows model settings beside refresh inside the picker", async () => {
    renderPicker([configuredModel, unconfiguredModel]);

    fireEvent.click(screen.getByRole("combobox"));

    const refresh = await screen.findByRole("button", {
      name: "Refresh models",
    });
    const settings = screen.getByRole("button", {
      name: "Configure model providers",
    });
    expect(settings.parentElement).toBe(refresh.parentElement);

    fireEvent.click(settings);
    expect(navigate).toHaveBeenCalledWith({
      to: "/settings/models",
      search: {},
    });
  });

  it("shows a useful favorites empty state without leaving the favorites tab", async () => {
    renderPicker([configuredModel, unconfiguredModel]);
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.modelPicker.compact" })
    );

    fireEvent.click(await screen.findByRole("button", { name: "Favorites" }));

    const emptyState = screen
      .getByText("No favorites")
      .closest('[data-slot="combobox-empty"]');
    expect(emptyState?.parentElement?.getAttribute("data-empty")).toBe("");
    expect(
      screen
        .getByRole("button", { name: "Favorites" })
        .getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("filters the list by the search text", async () => {
    const secondConfigured: ModelAvailability = {
      ...unconfiguredModel,
      configured: true,
    };
    renderPicker([configuredModel, secondConfigured]);
    fireEvent.click(screen.getByRole("combobox"));

    const search = await screen.findByPlaceholderText("Search models");
    fireEvent.change(search, { target: { value: "Claude" } });

    await waitFor(() =>
      expect(
        document.querySelector(
          `[data-id="local-code-model-option-${secondConfigured.id}"]`
        )
      ).not.toBeNull()
    );
    expect(
      document.querySelector(
        `[data-id="local-code-model-option-${configuredModel.id}"]`
      )
    ).toBeNull();
  });

  it("drops a provider's models from the list when its key is gone", async () => {
    renderPicker([configuredModel, unconfiguredModel]);
    fireEvent.click(screen.getByRole("combobox"));

    await screen.findByPlaceholderText("Search models");
    expect(
      document.querySelector(
        `[data-id="local-code-model-option-${unconfiguredModel.id}"]`
      )
    ).toBeNull();
    expect(
      document.querySelector(
        `[data-id="local-code-model-option-${configuredModel.id}"]`
      )
    ).not.toBeNull();
  });

  // Nothing in the picker sells a plan: the free tier's way on is the two
  // connect rows, which run the shared connect hop.
  it("connects OpenRouter from its row and refreshes the list, selling nothing", async () => {
    const startOpenRouterAuth = vi.fn(async () => ({ ok: true }));
    const listModels = vi.fn(async () => []);
    const onModelsRefreshed = vi.fn();
    (globalThis.window as unknown as { api: unknown }).api = {
      agent: {
        getAbacusAccount: async () => ({ subscription_tier: "free" }),
        startOpenRouterAuth,
        listModels,
      },
      openExternal,
    };
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ModelPicker
          models={[configuredModel]}
          selectedModelValue={configuredModel.id}
          activeWorkspaceId="workspace-one"
          onSelectModel={vi.fn()}
          onModelsRefreshed={onModelsRefreshed}
        />
      </QueryClientProvider>
    );
    fireEvent.click(screen.getByRole("combobox"));

    const row = await waitFor(() => {
      const found = document.querySelector(
        '[data-id="local-code-model-option-connect/openrouter"]'
      );
      expect(found).not.toBeNull();
      return found!;
    });
    expect(
      document.querySelector('[data-id="model-picker-upgrade-card"]')
    ).toBeNull();

    fireEvent.click(row);
    await waitFor(() => expect(onModelsRefreshed).toHaveBeenCalledTimes(1));
    expect(startOpenRouterAuth).toHaveBeenCalledTimes(1);
    expect(listModels).toHaveBeenCalledWith(true);
    expect(openExternal).not.toHaveBeenCalled();
  });

  // Connecting Gemini used to open the browser and send the user to Settings;
  // the key dialog every other entry point uses opens here instead.
  it("opens the shared key dialog in place for Connect Gemini", async () => {
    const saveApiKey = vi.fn(async () => ({}));
    const listModels = vi.fn(async () => []);
    (globalThis.window as unknown as { api: unknown }).api = {
      agent: {
        getAbacusAccount: async () => ({ subscription_tier: "free" }),
        saveApiKey,
        listModels,
      },
      openExternal,
    };
    renderPicker([configuredModel]);
    fireEvent.click(screen.getByRole("combobox"));

    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-id="local-code-model-option-connect/gemini"]'
        )
      ).toBeTruthy()
    );
    fireEvent.click(
      document.querySelector(
        '[data-id="local-code-model-option-connect/gemini"]'
      )!
    );

    await waitFor(() =>
      expect(
        document.querySelector('[data-id="provider-key-dialog"]')
      ).toBeTruthy()
    );
    // No trip to Settings and no blind browser open: the dialog carries the link.
    expect(navigate).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();

    fireEvent.change(
      document.querySelector('[data-id="provider-key-input"]')!,
      {
        target: { value: "AIzaSy-a-real-looking-key" },
      }
    );
    fireEvent.click(document.querySelector('[data-id="provider-key-save"]')!);

    await waitFor(() =>
      expect(saveApiKey).toHaveBeenCalledWith(
        "gemini",
        "AIzaSy-a-real-looking-key"
      )
    );
  });

  it("shows no upgrade card off the free tier", async () => {
    (globalThis.window as unknown as { api: unknown }).api = {
      agent: {
        getAbacusAccount: async () => ({ subscription_tier: "pro" }),
      },
      openExternal,
    };
    renderPicker([configuredModel]);
    fireEvent.click(screen.getByRole("combobox"));

    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-id="local-code-model-option-openai/gpt-5.6"]'
        )
      ).toBeTruthy()
    );
    expect(
      document.querySelector('[data-id="model-picker-upgrade-card"]')
    ).toBeNull();
  });
});
