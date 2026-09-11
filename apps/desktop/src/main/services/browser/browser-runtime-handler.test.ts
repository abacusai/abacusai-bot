import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
}));

import { IpcChannels } from "#shared/channels";

import { registerBrowserRuntimeIpcHandlers } from "./browser-runtime-handler";

describe("browser runtime IPC", () => {
  const runtime = {
    materialize: vi.fn(),
    present: vi.fn(),
    navigate: vi.fn(),
    capture: vi.fn(),
    hide: vi.fn(),
    close: vi.fn(),
    promoteScope: vi.fn(),
    disposeScope: vi.fn(),
    disposeWorkspace: vi.fn(),
  };

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    registerBrowserRuntimeIpcHandlers(runtime, () => 42);
  });

  it("routes scoped operations from the owning renderer", async () => {
    const request = { resourceId: "browser-one" };
    runtime.materialize.mockResolvedValue({ lease: request });

    await handlers.get(IpcChannels.MaterializeBrowserRuntime)?.(
      { sender: { id: 42 } },
      request
    );

    expect(runtime.materialize).toHaveBeenCalledWith(request);
  });

  it("rejects calls from guest web contents", async () => {
    expect(() =>
      handlers.get(IpcChannels.CloseBrowserRuntime)?.(
        { sender: { id: 9 } },
        { resourceId: "browser-one" }
      )
    ).toThrow("restricted to the main renderer");
    expect(runtime.close).not.toHaveBeenCalled();
  });

  it("registers promotion and both disposal boundaries", async () => {
    const event = { sender: { id: 42 } };
    const promotion = {
      draftConversationKey: "draft",
      sessionConversationKey: "session",
    };

    await handlers.get(IpcChannels.PromoteBrowserRuntimeScope)?.(
      event,
      promotion
    );
    await handlers.get(IpcChannels.DisposeBrowserRuntimeScope)?.(
      event,
      "session"
    );
    await handlers.get(IpcChannels.DisposeBrowserRuntimeWorkspace)?.(
      event,
      "workspace-one"
    );

    expect(runtime.promoteScope).toHaveBeenCalledWith(promotion);
    expect(runtime.disposeScope).toHaveBeenCalledWith("session");
    expect(runtime.disposeWorkspace).toHaveBeenCalledWith("workspace-one");
  });
});
