import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
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
  const client = {
    devices: {
      list: async () => [
        { id: "ios1", name: "iPhone", platform: "ios", state: "booted" },
      ],
      boot,
      buildAndRun: vi.fn(),
      interact: vi.fn(),
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
  };
  mocks.transport = { client, orpc: createTanstackQueryUtils(client as never) };
  const qc = new QueryClient();
  const routeTree = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <DeviceTab visible />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(<RouterProvider router={router} />);
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
it("a build is sent once while it runs and its failure is shown", async () => {
  await initI18n();
  let fail!: (error: Error) => void;
  const buildAndRun = vi.fn(() => new Promise((_, reject) => (fail = reject)));
  const client = {
    devices: {
      list: async () => [
        { id: "a1", name: "Pixel", platform: "android", state: "booted" },
      ],
      boot: vi.fn(),
      buildAndRun,
      interact: vi.fn(),
    },
    system: { openPrivacyPane: vi.fn() },
  };
  mocks.transport = { client, orpc: createTanstackQueryUtils(client as never) };
  const qc = new QueryClient();
  const routeTree = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        {/* Hidden: no capture runs, only the controls. */}
        <DeviceTab visible={false} />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(<RouterProvider router={router} />);
  try {
    fireEvent.click(await screen.findByRole("button", { name: "Pixel" }));
    const build = await screen.findByRole("button", {
      name: enUS.sessions.device.build,
    });
    fireEvent.click(build);
    await waitFor(() => expect(build.hasAttribute("disabled")).toBe(true));
    fireEvent.click(build);
    expect(buildAndRun).toHaveBeenCalledOnce();
    fail(new Error("gradle failed"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "gradle failed"
    );
    expect(build.hasAttribute("disabled")).toBe(false);
  } finally {
    view.unmount();
    qc.clear();
  }
});
