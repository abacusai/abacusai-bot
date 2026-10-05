import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { DeviceStreamPlayer } from "#renderer/components/device/stream-player";
import { initI18n } from "#renderer/lib/i18n";
const mocks = vi.hoisted(() => ({ transport: {} as any }));
vi.mock("../data/queries", () => ({
  useSessionsTransport: () => mocks.transport,
}));
import { DeviceTab } from "./device-tab";
it("internal decoder configuration failure stops streaming, disposes and starts Simulator fallback once", async () => {
  await initI18n();
  const configure = vi.fn(() => {
    throw new Error("unsupported codec");
  });
  vi.stubGlobal(
    "VideoDecoder",
    class {
      state = "unconfigured";
      close = vi.fn();
      configure = configure;
    }
  );
  const dispose = vi.spyOn(DeviceStreamPlayer.prototype, "dispose");
  const stop = vi.fn(async () => {}),
    boot = vi.fn(async () => {}),
    source = vi.fn(async () => ({
      screenPermission: "denied",
      sourceId: null,
    }));
  let chunksSignal: AbortSignal | undefined;
  mocks.transport = {
    client: {
      devices: {
        boot,
        simulatorWindowSource: source,
        screenshot: vi.fn().mockRejectedValue(new Error("no snapshot")),
        stream: {
          start: async () => ({ success: true, streamId: 1 }),
          stop,
          chunks: async function* (
            _: unknown,
            { signal }: { signal: AbortSignal }
          ) {
            chunksSignal = signal;
            yield {
              streamId: 1,
              isKey: true,
              data: new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0, 0x1e]),
            };
          },
        },
      },
      system: { openPrivacyPane: vi.fn() },
    },
    orpc: {
      devices: {
        list: {
          queryOptions: () => ({
            queryKey: ["devices"],
            queryFn: async () => [
              { id: "ios1", name: "iPhone", platform: "ios", state: "booted" },
            ],
          }),
        },
      },
    },
  };
  const qc = new QueryClient();
  const view = render(
    <QueryClientProvider client={qc}>
      <DeviceTab visible />
    </QueryClientProvider>
  );
  try {
    fireEvent.click(await screen.findByRole("button", { name: "iPhone" }));
    await waitFor(() => expect(source).toHaveBeenCalledOnce());
    expect(configure).toHaveBeenCalledOnce();
    expect(boot).toHaveBeenCalledExactlyOnceWith({
      platform: "ios",
      deviceId: "ios1",
      focus: false,
    });
    expect(stop).toHaveBeenCalledExactlyOnceWith({ streamId: 1 });
    expect(dispose).toHaveBeenCalledOnce();
    expect(chunksSignal?.aborted).toBe(true);
  } finally {
    view.unmount();
    qc.clear();
    dispose.mockRestore();
    vi.unstubAllGlobals();
  }
});
