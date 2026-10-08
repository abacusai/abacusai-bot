import { contract } from "@abacus-ai/contract/contract";
import { MODEL_CATALOG } from "@abacus-ai/contract/models";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

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

it("keeps the same focused composer through a normal start and checkout failure", async () => {
  startDraftStore.setState(() => ({
    ...newStartDraft(),
    workspaceId: "default",
  }));
  let rejectCheckout!: (error: Error) => void;
  const checkout = new Promise<never>((_, reject) => {
    rejectCheckout = reject;
  });
  const os = implement(contract);
  const harness = await renderApp("/sessions/new", {
    procedures: {
      settings: {
        get: os.settings.get.handler(
          () => ({ defaultModel: "openllm/auto", apiKeys: {} }) as never
        ),
      },
      models: {
        list: os.models.list.handler(() =>
          MODEL_CATALOG.map((model) => ({ ...model, configured: true }))
        ),
      },
      git: {
        worktrees: {
          setForSession: os.git.worktrees.setForSession.handler(() => checkout),
        },
      },
    },
  });
  try {
    const field = await screen.findByRole("textbox", {
      name: "Tell the agent what to do…",
    });
    fireEvent.change(field, { target: { value: "List the files" } });
    field.focus();
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Send message" })
          .hasAttribute("disabled")
      ).toBe(false)
    );
    const removed: Node[] = [];
    const observer = new MutationObserver((records) =>
      records.forEach((record) => removed.push(...record.removedNodes))
    );
    observer.observe(harness.view.container, {
      subtree: true,
      childList: true,
    });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(startDraftStore.state.stage).toBe("created"));
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.getByRole("textbox")).toBe(field);
    expect(document.activeElement).toBe(field);
    expect((field as HTMLTextAreaElement).value).toBe("List the files");
    expect((field as HTMLTextAreaElement).readOnly).toBe(true);
    expect(removed.some((node) => node === field || node.contains(field))).toBe(
      false
    );
    rejectCheckout(new Error("Checkout unavailable"));
    await waitFor(() =>
      expect((field as HTMLTextAreaElement).readOnly).toBe(false)
    );
    expect((field as HTMLTextAreaElement).value).toBe("List the files");
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(await screen.findByText("Error: Checkout unavailable")).toBeTruthy();
    observer.disconnect();
  } finally {
    harness.view.unmount();
    await harness.cleanup();
    startDraftStore.setState(newStartDraft);
  }
});
