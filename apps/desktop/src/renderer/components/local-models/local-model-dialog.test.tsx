/**
 * The one-click local model dialog: the recommended model for this machine,
 * a download with progress, and the model handed back once it is ready.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalModelState } from "#shared/local-models";
import { LOCAL_MODEL_CATALOG } from "#shared/local-models";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values == null ? key : `${key} ${JSON.stringify(values)}`,
  }),
}));

const { LocalModelDialog, gigabytes } = await import("./local-model-dialog");
const { useLocalModelDialogStore } =
  await import("../../stores/local-model-dialog-store");

const GB = 1024 ** 3;
let state: LocalModelState;
let listeners: Array<(event: unknown) => void>;
const installLocalModel = vi.fn(async (): Promise<unknown> => ({
  ok: true,
  model: "local/qwen3.5-4b",
}));
const cancelLocalModelInstall = vi.fn(async () => undefined);

const byId = (id: string) =>
  document.querySelector<HTMLElement>(`[data-id="${id}"]`);

const renderDialog = () =>
  render(
    (
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <LocalModelDialog />
      </QueryClientProvider>
    ) as JSX.Element
  );

beforeEach(() => {
  state = {
    runtimeAvailable: true,
    totalMemoryBytes: 8 * GB,
    recommendedId: "qwen3.5-4b",
    catalog: LOCAL_MODEL_CATALOG,
    installedIds: [],
    download: null,
    servingId: null,
  };
  listeners = [];
  installLocalModel.mockClear();
  cancelLocalModelInstall.mockClear();
  Object.assign(window, {
    api: {
      agent: {
        getLocalModelState: async () => state,
        installLocalModel,
        cancelLocalModelInstall,
        onEvent: (listener: (event: unknown) => void) => {
          listeners.push(listener);
          return () => {};
        },
      },
    },
  });
  useLocalModelDialogStore.setState({ open: false, onReady: null });
});

afterEach(cleanup);

describe("gigabytes", () => {
  it("rounds small files to a decimal and large ones to a whole number", () => {
    expect(gigabytes(2_740_937_888)).toBe("2.6 GB");
    expect(gigabytes(16_817_244_384)).toBe("16 GB");
  });
});

describe("LocalModelDialog", () => {
  it("stays out of the way until asked for", () => {
    renderDialog();
    expect(byId("local-model-dialog")).toBeNull();
  });

  it("offers the recommended model with its size, and downloads it on one click", async () => {
    const onReady = vi.fn();
    useLocalModelDialogStore.getState().show(onReady);
    renderDialog();

    await waitFor(() => expect(byId("local-model-recommended")).not.toBeNull());
    expect(byId("local-model-recommended")?.textContent).toContain(
      "Qwen 3.5 4B"
    );
    expect(byId("local-model-download")?.textContent).toContain(
      '"size":"2.6 GB"'
    );

    fireEvent.click(byId("local-model-download")!);

    await waitFor(() =>
      expect(installLocalModel).toHaveBeenCalledWith("qwen3.5-4b")
    );
    // Ready: the opener gets the model reference and the dialog goes.
    await waitFor(() =>
      expect(onReady).toHaveBeenCalledWith("local/qwen3.5-4b")
    );
    expect(useLocalModelDialogStore.getState().open).toBe(false);
  });

  it("shows the download's progress as events arrive, with a way to stop", async () => {
    installLocalModel.mockImplementationOnce(() => new Promise(() => {}));
    useLocalModelDialogStore.getState().show();
    renderDialog();
    await waitFor(() => expect(byId("local-model-download")).not.toBeNull());
    fireEvent.click(byId("local-model-download")!);

    for (const listener of listeners)
      listener({
        type: "local-model-progress",
        progress: {
          modelId: "qwen3.5-4b",
          phase: "downloading",
          receivedBytes: GB,
          totalBytes: 4 * GB,
        },
      });

    await waitFor(() => expect(byId("local-model-progress")).not.toBeNull());
    expect(byId("local-model-progress")?.textContent).toContain('"percent":25');
    expect(byId("local-model-download")).toBeNull();

    fireEvent.click(byId("local-model-cancel")!);
    expect(cancelLocalModelInstall).toHaveBeenCalledTimes(1);
  });

  it("hands over an already installed model without downloading again", async () => {
    state.installedIds = ["qwen3.5-4b"];
    const onReady = vi.fn();
    useLocalModelDialogStore.getState().show(onReady);
    renderDialog();

    await waitFor(() => expect(byId("local-model-use")).not.toBeNull());
    fireEvent.click(byId("local-model-use")!);

    expect(onReady).toHaveBeenCalledWith("local/qwen3.5-4b");
    expect(installLocalModel).not.toHaveBeenCalled();
  });

  it("says what went wrong and keeps the dialog for another try", async () => {
    installLocalModel.mockResolvedValueOnce({
      ok: false,
      error: "the disk is full",
    });
    useLocalModelDialogStore.getState().show();
    renderDialog();
    await waitFor(() => expect(byId("local-model-download")).not.toBeNull());
    fireEvent.click(byId("local-model-download")!);

    await waitFor(() =>
      expect(byId("local-model-error")?.textContent).toBe("the disk is full")
    );
    expect(useLocalModelDialogStore.getState().open).toBe(true);
  });

  it("warns when the machine is tight for even the smallest model", async () => {
    state.totalMemoryBytes = 4 * GB;
    useLocalModelDialogStore.getState().show();
    renderDialog();

    await waitFor(() => expect(byId("local-model-recommended")).not.toBeNull());
    expect(byId("local-model-recommended")?.textContent).toContain(
      "localModels.tight"
    );
  });

  it("explains itself on a build without the runtime", async () => {
    state.runtimeAvailable = false;
    useLocalModelDialogStore.getState().show();
    renderDialog();

    await waitFor(() =>
      expect(document.body.textContent).toContain("localModels.unavailable")
    );
    expect(byId("local-model-download")).toBeNull();
  });
});
