import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";

import { renderApp } from "#next/test-support/app-harness";

import { newStartDraft, startDraftStore } from "./start-session";
it("created envelope retains the checkout picker and allows explicit No worktree recovery", async () => {
  startDraftStore.setState(() => ({
    ...newStartDraft(),
    stage: "created",
    workspaceId: "default",
    worktree: { kind: "new", baseRef: "main" },
    envelope: {
      runId: "r",
      messageId: "m",
      parts: [{ type: "text", content: "Saved first message" }],
    },
  }));
  const harness = await renderApp("/sessions/new");
  try {
    expect(await screen.findByText("Saved first message")).toBeTruthy();
    const tray = document.querySelector('[data-slot="session-context-tray"]');
    expect(tray).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New worktree" }));
    fireEvent.click(await screen.findByRole("button", { name: "No worktree" }));
    await waitFor(() =>
      expect(startDraftStore.state.worktree).toEqual({ kind: "current" })
    );
    expect(startDraftStore.state.stage).toBe("created");
  } finally {
    harness.view.unmount();
    await harness.cleanup();
    startDraftStore.setState(newStartDraft);
  }
});
