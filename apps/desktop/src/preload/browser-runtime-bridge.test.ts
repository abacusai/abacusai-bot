import { describe, expect, it, vi } from "vitest";

import { IpcChannels } from "#shared/channels";
import { draftConversationKey } from "#shared/conversation-scope";

import { createBridge } from "./bridge";

describe("browser runtime preload bridge", () => {
  it("forwards typed lifecycle requests without reshaping them", async () => {
    const invoke = vi.fn(async () => undefined);
    const bridge = createBridge({ invoke } as never);
    const conversationKey = draftConversationKey("workspace-one");
    const materialize = {
      conversationKey,
      resourceId: "browser-one",
      profileId: "chrome:Default",
      url: "https://example.com",
    };
    const lease = { conversationKey, resourceId: "browser-one", generation: 1 };

    await bridge.materializeBrowserRuntime(materialize);
    await bridge.presentBrowserRuntime({
      lease,
      presentationId: "surface-one",
      bounds: { x: 10, y: 20, width: 640, height: 480 },
    });
    await bridge.navigateBrowserRuntime({
      lease,
      navigation: { action: "reload" },
    });
    await bridge.captureBrowserRuntime(lease);
    await bridge.hideBrowserRuntime({ lease, presentationId: "surface-one" });
    await bridge.closeBrowserRuntime(lease);

    expect(invoke.mock.calls).toEqual([
      [IpcChannels.MaterializeBrowserRuntime, materialize],
      [
        IpcChannels.PresentBrowserRuntime,
        {
          lease,
          presentationId: "surface-one",
          bounds: { x: 10, y: 20, width: 640, height: 480 },
        },
      ],
      [
        IpcChannels.NavigateBrowserRuntime,
        { lease, navigation: { action: "reload" } },
      ],
      [IpcChannels.CaptureBrowserRuntime, lease],
      [
        IpcChannels.HideBrowserRuntime,
        { lease, presentationId: "surface-one" },
      ],
      [IpcChannels.CloseBrowserRuntime, lease],
    ]);
  });
});
