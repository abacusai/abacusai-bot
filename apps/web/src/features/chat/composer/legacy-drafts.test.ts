import { expect, it, vi } from "vitest";

import { draftStore, clearDraft } from "./draft-store";

it("imports a synthetic v1.0.85 durable draft once without overwriting a new draft", async () => {
  const { importLegacyDrafts } = await import("./draft-store");
  const acknowledge = vi.fn().mockResolvedValue(undefined);
  const legacy = {
    "old-thread": "unsent legacy words",
    "edited-thread": "old words",
  };
  draftStore.setState(() => ({
    "edited-thread": { text: "new words", attachments: [] },
  }));
  await importLegacyDrafts(legacy, acknowledge);
  expect(draftStore.state["old-thread"]).toEqual({
    text: "unsent legacy words",
    attachments: [],
  });
  expect(draftStore.state["edited-thread"]?.text).toBe("new words");
  expect(
    JSON.parse(sessionStorage.getItem("abacusai-bot:abacus.chat.drafts")!)[
      "old-thread"
    ].text
  ).toBe("unsent legacy words");
  expect(acknowledge).toHaveBeenCalledWith(["old-thread", "edited-thread"]);
  clearDraft("old-thread");
  await importLegacyDrafts(legacy, acknowledge);
  expect(draftStore.state["old-thread"]?.text).toBe("");
});
