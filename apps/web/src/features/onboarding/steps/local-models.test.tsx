/**
 * The local-model row (canvas OnboardModels, spec 06 F12): the recommended
 * model with its size; Download starts the install; a download in flight
 * shows the bar, the percentage and Stop; an installed model reads
 * Installed; no row when the build cannot run models locally.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Transport } from "#renderer/data/transport";
import { initI18n } from "#renderer/lib/i18n";

import { OnboardingLocalModels } from "./local-models";

vi.mock("#renderer/data/queries/notices", () => ({
  followNotices: async () => {},
}));

const spec = {
  id: "qwen3-8b",
  label: "Qwen3 8B",
  sizeBytes: 4.9 * 1024 ** 3,
};
const host = (
  patch: Partial<{
    runtimeAvailable: boolean;
    installedIds: string[];
    download: {
      modelId: string;
      phase: string;
      receivedBytes: number;
      totalBytes: number;
    } | null;
  }> = {}
) => {
  const state = {
    runtimeAvailable: true,
    totalMemoryBytes: 32 * 1024 ** 3,
    recommendedId: spec.id,
    catalog: [spec],
    installedIds: [],
    download: null,
    servingId: null,
    ...patch,
  };
  const install = vi.fn(async () => ({ ok: true }));
  const cancelInstall = vi.fn(async () => {});
  const transport = {
    orpc: {
      localModels: {
        state: {
          queryOptions: () => ({
            queryKey: ["local-models"],
            queryFn: async () => state,
          }),
        },
      },
    },
    client: { localModels: { install, cancelInstall, progress: vi.fn() } },
  } as unknown as Transport;
  return { transport, install, cancelInstall };
};
const mount = async (transport: Transport, saved = vi.fn(async () => {})) => {
  await initI18n();
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <OnboardingLocalModels transport={transport} saved={saved} />
    </QueryClientProvider>
  );
  return { view, saved };
};

describe("OnboardingLocalModels", () => {
  it("offers the recommended model with its size and installs it on Download", async () => {
    const { transport, install } = host();
    const { saved } = await mount(transport);
    const row = await screen.findByText("Run a model");
    expect(row.closest("[data-slot=local-model-row]")!.textContent).toContain(
      "Qwen3 8B, 4.9 GB, no account"
    );
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await vi.waitFor(() => expect(saved).toHaveBeenCalled());
    expect(install).toHaveBeenCalledWith({ modelId: spec.id });
  });

  it("shows the download's progress and lets it stop", async () => {
    const { transport, cancelInstall } = host({
      download: {
        modelId: spec.id,
        phase: "downloading",
        receivedBytes: 42,
        totalBytes: 100,
      },
    });
    await mount(transport);
    const bar = await screen.findByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    expect(screen.getByRole("status").textContent).toContain("Downloading");
    expect(screen.getByRole("status").textContent).toContain("42%");
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop download" }));
    expect(cancelInstall).toHaveBeenCalled();
  });

  it("reads Installed once the model is on disk", async () => {
    const { transport } = host({ installedIds: [spec.id] });
    await mount(transport);
    expect(await screen.findByText("Installed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });

  it("renders nothing when the build cannot run models locally", async () => {
    const { transport } = host({ runtimeAvailable: false });
    const { view } = await mount(transport);
    await vi.waitFor(() =>
      expect(
        view.container.querySelector("[data-slot=local-model-row]")
      ).toBeNull()
    );
    expect(screen.queryByText("Run a model")).toBeNull();
  });
});
