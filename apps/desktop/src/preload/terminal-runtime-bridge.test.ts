import { describe, expect, it, vi } from "vitest";

import { IpcChannels } from "#shared/channels";
import {
  conversationKey,
  draftConversationRef,
  sessionConversationRef,
} from "#shared/conversation-scope";

import { createBridge } from "./bridge";

describe("terminal runtime preload bridge", () => {
  it("forwards scoped lifecycle requests without reshaping them", async () => {
    const invoke = vi.fn(async () => undefined);
    const bridge = createBridge({ invoke } as never);
    const conversation = draftConversationRef("workspace-one");
    const key = conversationKey(conversation);
    const start = {
      conversationKey: key,
      conversation,
      generation: null,
      cols: 80,
      rows: 24,
    };
    const lease = { conversationKey: key, generation: 2 };

    await bridge.startTerminalSession(start);
    await bridge.writeTerminalInput({ ...lease, data: "pwd\n" });
    await bridge.resizeTerminalSession({ ...lease, cols: 120, rows: 40 });
    await bridge.hideTerminalSession(lease);

    const sessionConversation = sessionConversationRef(
      "workspace-one",
      "session-one"
    );
    const promotion = {
      draftConversationKey: key,
      draftConversation: conversation,
      sessionConversationKey: conversationKey(sessionConversation),
      sessionConversation,
    };
    await bridge.promoteTerminalSessionScope(promotion);

    expect(invoke.mock.calls).toEqual([
      [IpcChannels.StartTerminalSession, start],
      [IpcChannels.WriteTerminalInput, { ...lease, data: "pwd\n" }],
      [IpcChannels.ResizeTerminalSession, { ...lease, cols: 120, rows: 40 }],
      [IpcChannels.HideTerminalSession, lease],
      [IpcChannels.PromoteTerminalSessionScope, promotion],
    ]);
  });
});
