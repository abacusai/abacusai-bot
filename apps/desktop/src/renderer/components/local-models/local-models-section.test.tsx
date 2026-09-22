/** The settings page's "On this machine" section, over the same state as the dialog. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalModelState } from "#shared/local-models";
import { LOCAL_MODEL_CATALOG } from "#shared/local-models";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { LocalModelsSection } = await import("./local-models-section");

let state: LocalModelState;
const installLocalModel = vi.fn(async () => ({
  ok: true,
  model: "local/qwen3.5-9b",
}));
const removeLocalModel = vi.fn(async () => undefined);

const byId = (id: string) =>
  document.querySelector<HTMLElement>(`[data-id="${id}"]`);

const renderSection = () =>
  render(
    (
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <LocalModelsSection />
      </QueryClientProvider>
    ) as JSX.Element
  );

beforeEach(() => {
  state = {
    runtimeAvailable: true,
    totalMemoryBytes: 16 * 1024 ** 3,
    recommendedId: "qwen3.5-9b",
    catalog: LOCAL_MODEL_CATALOG,
    installedIds: ["qwen3.5-4b"],
    download: null,
    servingId: null,
  };
  installLocalModel.mockClear();
  removeLocalModel.mockClear();
  Object.assign(window, {
    api: {
      agent: {
        getLocalModelState: async () => state,
        installLocalModel,
        removeLocalModel,
        cancelLocalModelInstall: async () => undefined,
        onEvent: () => () => {},
      },
    },
  });
});

afterEach(cleanup);

describe("LocalModelsSection", () => {
  it("lists the catalog, marks the recommendation and what is installed", async () => {
    renderSection();

    await waitFor(() => expect(byId("local-models-section")).not.toBeNull());
    expect(byId("local-model-qwen3.5-9b")?.textContent).toContain(
      "localModels.recommended"
    );
    expect(byId("local-model-qwen3.5-4b")?.textContent).toContain(
      "localModels.installed"
    );
    expect(byId("local-model-remove-qwen3.5-4b")).not.toBeNull();
    expect(byId("local-model-download-qwen3.5-9b")).not.toBeNull();
    expect(byId("local-model-download-qwen3.6-27b")).not.toBeNull();
  });

  it("downloads and removes through the bridge", async () => {
    renderSection();
    await waitFor(() =>
      expect(byId("local-model-download-qwen3.5-9b")).not.toBeNull()
    );

    fireEvent.click(byId("local-model-download-qwen3.5-9b")!);
    await waitFor(() =>
      expect(installLocalModel).toHaveBeenCalledWith("qwen3.5-9b")
    );

    fireEvent.click(byId("local-model-remove-qwen3.5-4b")!);
    await waitFor(() =>
      expect(removeLocalModel).toHaveBeenCalledWith("qwen3.5-4b")
    );
  });

  it("is absent on a build without the runtime", async () => {
    state.runtimeAvailable = false;
    renderSection();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(byId("local-models-section")).toBeNull();
  });
});
