import { contract } from "@abacus-ai/contract/contract";
import { MODEL_CATALOG } from "@abacus-ai/contract/models";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

import {
  newStartDraft,
  startDraftStore,
  optimisticSession,
} from "./start-session";
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
}, 20000);

it("keeps the same focused composer through a normal start and checkout failure", async () => {
  startDraftStore.setState(() => ({
    ...newStartDraft(),
    workspaceId: "default",
  }));
  let failCheckout!: () => void;
  const checkout = new Promise<{ success: false; error: string }>((resolve) => {
    failCheckout = () =>
      resolve({ success: false, error: "Checkout unavailable" });
  });
  const os = implement(contract);
  const harness = await renderApp("/sessions/new", {
    procedures: {
      settings: {
        promptHistory: { add: os.settings.promptHistory.add.handler(() => []) },
        get: os.settings.get.handler(
          () =>
            ({
              defaultModel: "openllm/auto",
              apiKeys: { ABACUS_API_KEY: "test-credential" },
            }) as never
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
    const field = await screen.findByRole(
      "textbox",
      {
        name: /Tell the agent/,
      },
      { timeout: 10000 }
    );
    fireEvent.change(field, { target: { value: "List the files" } });
    field.focus();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")
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
    expect(screen.getByRole("textbox", { name: /Tell the agent/ })).toBe(field);
    expect(document.activeElement).toBe(field);
    expect((field as HTMLTextAreaElement).value).toBe("List the files");
    expect((field as HTMLTextAreaElement).readOnly).toBe(true);
    expect(removed.some((node) => node === field || node.contains(field))).toBe(
      false
    );
    failCheckout();
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
}, 20000);

it.each(["created", "checkout-ready", "handed-off"] as const)(
  "shows %s recovery on its first render and continues the saved message",
  async (stage) => {
    const draft = {
      ...newStartDraft(),
      workspaceId: "default",
      stage,
      envelope: {
        runId: "saved-run",
        messageId: "saved-message",
        parts: [{ type: "text" as const, content: "Saved message" }],
      },
    };
    startDraftStore.setState(() => draft);
    const os = implement(contract);
    const mountedComposers: Element[] = [];
    const observer = new MutationObserver((records) =>
      records.forEach((record) =>
        record.addedNodes.forEach((node) => {
          if (node instanceof Element) {
            if (node.matches('[data-slot="composer"]'))
              mountedComposers.push(node);
            mountedComposers.push(
              ...node.querySelectorAll('[data-slot="composer"]')
            );
          }
        })
      )
    );
    observer.observe(document.body, { childList: true, subtree: true });
    const harness = await renderApp("/sessions/new", {
      beforeRender: (db) => db.sessions.upsert(optimisticSession(draft)),
      procedures: {
        git: {
          worktrees: {
            setForSession: os.git.worktrees.setForSession.handler(() => ({
              success: true,
            })),
          },
        },
        terminal: {
          promoteScope: os.terminal.promoteScope.handler(() => null),
        },
        browser: {
          runtime: {
            promoteScope: os.browser.runtime.promoteScope.handler(() => []),
          },
        },
      },
    });
    try {
      expect(
        screen.getByText("Your last message didn't finish sending.")
      ).toBeTruthy();
      expect(screen.getByText("Saved message")).toBeTruthy();
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Continue" })
      );
      expect(mountedComposers).toHaveLength(0);
      observer.disconnect();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await waitFor(() =>
        expect(harness.history.location.pathname).toBe(`/sessions/${draft.id}`)
      );
      await waitFor(() => expect(startDraftStore.state.stage).toBe("draft"));
      expect(harness.db.sessions.rows.has(draft.id)).toBe(true);
    } finally {
      observer.disconnect();
      harness.view.unmount();
      await harness.cleanup();
      startDraftStore.setState(newStartDraft);
    }
  },
  20000
);

it.each([true, false])(
  "discards an interrupted start with an existing row: %s",
  async (existing) => {
    const draft = {
      ...newStartDraft(),
      workspaceId: "default",
      stage: "created" as const,
      envelope: {
        runId: "r",
        messageId: "m",
        parts: [{ type: "text" as const, content: "Try again" }],
      },
    };
    startDraftStore.setState(() => draft);
    const harness = await renderApp("/sessions/new", {
      beforeRender: (db) => {
        if (existing) db.sessions.upsert(optimisticSession(draft));
      },
    });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Discard" }));
      await waitFor(() => expect(startDraftStore.state.stage).toBe("draft"));
      expect(startDraftStore.state.id).not.toBe(draft.id);
      expect(startDraftStore.state.envelope).toBeNull();
      expect(startDraftStore.state.workspaceId).toBe("default");
      expect(harness.db.sessions.rows.has(draft.id)).toBe(false);
      expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
      expect(
        (
          (await screen.findByRole("textbox", {
            name: /Tell the agent/,
          })) as HTMLTextAreaElement
        ).value
      ).toBe("Try again");
    } finally {
      harness.view.unmount();
      await harness.cleanup();
      startDraftStore.setState(newStartDraft);
    }
  },
  20000
);

it("keeps the composer mounted until a successful start finishes navigation", async () => {
  startDraftStore.setState(() => ({
    ...newStartDraft(),
    workspaceId: "default",
  }));
  const os = implement(contract);
  let finishNavigation!: () => void;
  const navigation = new Promise<void>((resolve) => {
    finishNavigation = resolve;
  });
  const harness = await renderApp("/sessions/new", {
    procedures: {
      settings: {
        promptHistory: { add: os.settings.promptHistory.add.handler(() => []) },
      },
      models: {
        list: os.models.list.handler(() =>
          MODEL_CATALOG.map((model) => ({ ...model, configured: true }))
        ),
      },
      git: {
        worktrees: {
          setForSession: os.git.worktrees.setForSession.handler(() => ({
            success: true,
          })),
        },
      },
      terminal: { promoteScope: os.terminal.promoteScope.handler(() => null) },
      browser: {
        runtime: {
          promoteScope: os.browser.runtime.promoteScope.handler(() => []),
        },
      },
    },
  });
  const navigate = vi
    .spyOn(harness.router, "navigate")
    .mockReturnValue(navigation);
  try {
    const field = await screen.findByRole("textbox", {
      name: /Tell the agent/,
    });
    fireEvent.change(field, { target: { value: "Start a session" } });
    field.focus();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")
      ).toBe(false)
    );
    const removed: Node[] = [];
    const observer = new MutationObserver((records) =>
      records.forEach((record) => removed.push(...record.removedNodes))
    );
    observer.observe(harness.view.container, {
      childList: true,
      subtree: true,
    });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(startDraftStore.state.stage).toBe("handed-off"));
    expect(navigate).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.getByRole("textbox", { name: /Tell the agent/ })).toBe(field);
    expect(document.activeElement).toBe(field);
    expect((field as HTMLTextAreaElement).value).toBe("Start a session");
    expect((field as HTMLTextAreaElement).readOnly).toBe(true);
    expect(removed.some((node) => node === field || node.contains(field))).toBe(
      false
    );
    observer.disconnect();
    finishNavigation();
    await waitFor(() => expect(startDraftStore.state.stage).toBe("draft"));
  } finally {
    finishNavigation();
    navigate.mockRestore();
    harness.view.unmount();
    await harness.cleanup();
    startDraftStore.setState(newStartDraft);
  }
}, 20000);
