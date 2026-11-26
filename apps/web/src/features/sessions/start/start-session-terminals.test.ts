import { draftConversationKey } from "@abacus-ai/contract/conversation-scope";
import { expect, it, vi } from "vitest";

const close = vi.fn(async () => true);
vi.mock("#renderer/data/transport", () => ({
  getTransport: async () => ({ client: { terminal: { close } } }),
}));

import { openTerminalTab, panelTabsStore } from "../dock/panel-tabs-store";
import {
  newStartDraft,
  openStartDraft,
  startDraftStore,
} from "./start-session";

it("a pruned empty new chat ends its shells in main by its key, with no screen left for them", async () => {
  const draft = { ...newStartDraft(), workspaceId: "w" };
  startDraftStore.setState(() => draft);
  const key = draftConversationKey("w", draft.id);
  // Its terminal's screen went when another chat was opened; its shell runs.
  openTerminalTab(key, { ref: "terminal:t1", title: "Terminal" });

  const next = openStartDraft();

  expect(next).not.toBe(draft.id);
  await vi.waitFor(() =>
    expect(close).toHaveBeenCalledWith({ conversationKey: key })
  );
  expect(panelTabsStore.state[key]?.tabs ?? []).toEqual([]);
});
