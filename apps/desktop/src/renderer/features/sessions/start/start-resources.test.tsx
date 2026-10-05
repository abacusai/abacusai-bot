import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { dispatchPreview } from "#renderer/features/shell";
import { renderApp } from "#renderer/test-support/app-harness";
import { draftConversationKey } from "#shared/conversation-scope";

import { newStartDraft, startDraftStore } from "./start-session";

let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});
it("keyless URL previews on the start route use the draft browser scope and reject foreign scopes", async () => {
  startDraftStore.setState(() => ({
    ...newStartDraft(),
    workspaceId: "abacusai-bot",
  }));
  app = await renderApp("/sessions/new?workspace=abacusai-bot");
  await screen.findByText("What should we build?");
  await act(async () => {
    expect(
      dispatchPreview({
        conversationKey: draftConversationKey("other"),
        url: "https://other.test",
      })
    ).toBe(false);
    expect(dispatchPreview({ url: "https://draft.test" })).toBe(true);
  });
  await waitFor(() =>
    expect(
      app!.calls.some(
        ([name, input]) =>
          name === "browser.runtime.materialize" &&
          (input as { conversationKey: string; url: string })
            .conversationKey === draftConversationKey("abacusai-bot") &&
          (input as { url: string }).url === "https://draft.test"
      )
    ).toBe(true)
  );
  expect(screen.getByRole("region", { name: "Browser" })).toBeTruthy();
});
