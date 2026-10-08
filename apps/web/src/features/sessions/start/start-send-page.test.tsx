import { contract } from "@abacus-ai/contract/contract";
import { MODEL_CATALOG } from "@abacus-ai/contract/models";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

import {
  newStartDraft,
  startDraftStore,
  optimisticSession,
  type StartDraft,
} from "./start-session";

const os = implement(contract);
type SendContext = Parameters<Parameters<typeof os.ai.send.handler>[0]>[0];
const saved = (stage: StartDraft["stage"] = "created"): StartDraft => ({
  ...newStartDraft(),
  workspaceId: "default",
  stage,
  submittedAt: Date.now(),
  envelope: {
    runId: "saved-run",
    messageId: "saved-message",
    parts: [{ type: "text", content: "List the files" }],
  },
});
const mount = (
  send: Parameters<typeof os.ai.send.handler>[0],
  existing?: StartDraft
) =>
  renderApp("/sessions/new", {
    beforeRender: (db) => {
      if (existing) db.sessions.upsert(optimisticSession(existing));
    },
    procedures: {
      models: {
        list: os.models.list.handler(() =>
          MODEL_CATALOG.map((model) => ({ ...model, configured: true }))
        ),
      },
      settings: {
        promptHistory: { add: os.settings.promptHistory.add.handler(() => []) },
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
      ai: { send: os.ai.send.handler(send) },
    },
  });
afterEach(() => startDraftStore.setState(newStartDraft));

it("keeps the focused composer and text through admission and navigation without a recovery panel", async () => {
  startDraftStore.setState(() => ({
    ...newStartDraft(),
    workspaceId: "default",
  }));
  let accept!: () => void, finishNavigation!: () => void;
  const admitted = new Promise<void>((r) => {
    accept = r;
  });
  const navigation = new Promise<void>((r) => {
    finishNavigation = r;
  });
  const sends = vi.fn(async ({ input }: SendContext) => {
    await admitted;
    return { runId: input.runId, status: "started" as const };
  });
  const h = await mount(sends);
  const navigate = vi.spyOn(h.router, "navigate").mockReturnValue(navigation);
  const removed: Node[] = [];
  const observer = new MutationObserver((records) =>
    records.forEach((r) => removed.push(...r.removedNodes))
  );
  try {
    const field = await screen.findByRole("textbox", {
      name: /Tell the agent/,
    });
    fireEvent.change(field, { target: { value: "List the files" } });
    field.focus();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")
      ).toBe(false)
    );
    observer.observe(h.view.container, { childList: true, subtree: true });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(sends).toHaveBeenCalledOnce());
    expect(screen.getByRole("textbox", { name: /Tell the agent/ })).toBe(field);
    expect((field as HTMLTextAreaElement).value).toBe("List the files");
    expect((field as HTMLTextAreaElement).readOnly).toBe(true);
    expect(document.activeElement).toBe(field);
    accept();
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect((field as HTMLTextAreaElement).readOnly).toBe(true);
    expect(removed.some((n) => n === field || n.contains(field))).toBe(false);
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    finishNavigation();
    await waitFor(() => expect(startDraftStore.state.stage).toBe("draft"));
  } finally {
    observer.disconnect();
    accept();
    finishNavigation();
    navigate.mockRestore();
    h.view.unmount();
    await h.cleanup();
  }
}, 20000);

it.each(["created", "checkout-ready", "handed-off"] as const)(
  "silently resumes %s once without a first-paint panel",
  async (stage) => {
    const draft = saved(stage);
    startDraftStore.setState(() => draft);
    let accept!: () => void;
    const admitted = new Promise<void>((r) => {
      accept = r;
    });
    const sends = vi.fn(async ({ input }: SendContext) => {
      await admitted;
      return {
        runId: input.runId,
        status: "duplicate" as const,
        original: "started" as const,
      };
    });
    const panels: Node[] = [];
    const observer = new MutationObserver((records) =>
      records.forEach((r) =>
        r.addedNodes.forEach((n) => {
          if (
            n.textContent?.includes("Finishing your last session") ||
            n.textContent?.includes("Your last message didn't finish sending")
          )
            panels.push(n);
        })
      )
    );
    observer.observe(document.body, { childList: true, subtree: true });
    const h = await mount(sends, draft);
    try {
      const field = await screen.findByRole("textbox", {
        name: /Tell the agent/,
      });
      expect((field as HTMLTextAreaElement).value).toBe("List the files");
      expect((field as HTMLTextAreaElement).readOnly).toBe(true);
      await waitFor(() => expect(sends).toHaveBeenCalledOnce());
      expect(sends.mock.calls[0]![0].input).toMatchObject({
        threadId: draft.id,
        startId: draft.id,
        runId: "saved-run",
        messages: [{ id: "saved-message" }],
      });
      expect(panels).toHaveLength(0);
      expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
      accept();
      await waitFor(() =>
        expect(h.history.location.pathname).toBe(`/sessions/${draft.id}`)
      );
      expect(h.db.sessions.rows.has(draft.id)).toBe(true);
    } finally {
      observer.disconnect();
      accept();
      h.view.unmount();
      await h.cleanup();
    }
  },
  20000
);

it("restores text after a failed automatic resume and retries with the original identities", async () => {
  const draft = saved();
  startDraftStore.setState(() => draft);
  const sends = vi.fn(({ input }: SendContext) => ({
    runId: input.runId,
    status: "started" as const,
  }));
  let fail = true;
  const h = await mount(({ input, ...rest }) => {
    if (fail) throw new Error("Host offline");
    return sends({ input, ...rest });
  }, draft);
  try {
    const field = await screen.findByRole("textbox", {
      name: /Tell the agent/,
    });
    await waitFor(() =>
      expect((field as HTMLTextAreaElement).readOnly).toBe(false)
    );
    expect((field as HTMLTextAreaElement).value).toBe("List the files");
    expect(h.view.container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    fail = false;
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(sends).toHaveBeenCalledOnce());
    expect(sends.mock.calls[0]![0].input.runId).toBe("saved-run");
    await waitFor(() =>
      expect(h.history.location.pathname).toBe(`/sessions/${draft.id}`)
    );
  } finally {
    h.view.unmount();
    await h.cleanup();
  }
}, 20000);

it.each([
  "old",
  "missing-session",
  "missing-workspace",
  "unknown-age",
] as const)(
  "restores an obsolete %s draft without sending",
  async (reason) => {
    const draft = saved();
    if (reason === "old") draft.submittedAt = Date.now() - 25 * 60 * 60 * 1000;
    if (reason === "unknown-age") {
      delete draft.submittedAt;
      draft.stage = "draft";
    }
    if (reason === "missing-workspace") draft.workspaceId = "deleted-workspace";
    startDraftStore.setState(() => draft);
    const sends = vi.fn(({ input }: SendContext) => ({
      runId: input.runId,
      status: "started" as const,
    }));
    const h = await mount(
      sends,
      reason === "missing-session" ? undefined : draft
    );
    try {
      const field = await screen.findByRole("textbox", {
        name: /Tell the agent/,
      });
      expect((field as HTMLTextAreaElement).value).toBe("List the files");
      expect((field as HTMLTextAreaElement).readOnly).toBe(false);
      expect(startDraftStore.state.stage).toBe("draft");
      expect(startDraftStore.state.envelope).toBeNull();
      expect(sends).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    } finally {
      h.view.unmount();
      await h.cleanup();
    }
  },
  20000
);

it("shares an automatic resume across a double mount and navigates the current mount", async () => {
  const draft = saved();
  startDraftStore.setState(() => draft);
  let accept!: () => void;
  const admitted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const sends = vi.fn(async ({ input }: SendContext) => {
    await admitted;
    return {
      runId: input.runId,
      status: "duplicate" as const,
      original: "started" as const,
    };
  });
  const first = await mount(sends, draft);
  await waitFor(() => expect(sends).toHaveBeenCalledOnce());
  first.view.unmount();
  const second = await mount(sends, startDraftStore.state);
  try {
    const field = await screen.findByRole("textbox", {
      name: /Tell the agent/,
    });
    expect((field as HTMLTextAreaElement).value).toBe("List the files");
    expect((field as HTMLTextAreaElement).readOnly).toBe(true);
    expect(sends).toHaveBeenCalledOnce();
    accept();
    await waitFor(() =>
      expect(second.history.location.pathname).toBe(`/sessions/${draft.id}`)
    );
    expect(sends).toHaveBeenCalledOnce();
  } finally {
    accept();
    second.view.unmount();
    await second.cleanup();
    await first.cleanup();
  }
}, 20000);
