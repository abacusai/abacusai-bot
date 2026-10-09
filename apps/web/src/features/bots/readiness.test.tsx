import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { fixtureBots, fixtureSessions } from "#renderer/data/fixture-db/rows";
import { requestBrowserOpen } from "#renderer/features/shell";
import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";

import { botsUnreadStore } from "./data/unread-store";

let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
  botsUnreadStore.clear("chief-of-staff");
  vi.restoreAllMocks();
});
it("waits for configured default mode before mounting a sendable composer", async () => {
  let resolve!: (mode: never) => void;
  app = await renderApp("/bots/chief-of-staff", {
    models: [
      {
        id: "abacus/route-llm",
        label: "RouteLLM",
        provider: "abacus",
        tier: "default",
        configured: true,
        recommended: true,
      },
    ],
    defaultMode: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  await screen.findByTestId("bot-chat");
  expect(
    screen.queryByRole("textbox", { name: /Message Chief of Staff/ })
  ).toBeNull();
  await act(async () => {
    resolve("DEFAULT" as never);
  });
  const input = await screen.findByRole("textbox", {
    name: /Message Chief of Staff/,
  });
  fireEvent.change(input, { target: { value: "Hello" } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
  await waitFor(() =>
    expect(app!.calls.some(([name]) => name === "ai.send")).toBe(true)
  );
  const sent = app.calls.find(([name]) => name === "ai.send")![1] as {
    forwardedProps: { mode: string };
  };
  expect(sent.forwardedProps.mode).toBe("DEFAULT");
});
it("recovers from a configured-mode rejection through Retry before allowing sends", async () => {
  let resolve!: (mode: never) => void;
  const defaultMode = vi
    .fn<() => Promise<never>>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
  app = await renderApp("/bots/chief-of-staff", {
    defaultMode,
    models: [
      {
        id: "abacus/route-llm",
        label: "RouteLLM",
        provider: "abacus",
        tier: "default",
        configured: true,
        recommended: true,
      },
    ],
  });
  await screen.findByTestId("bot-chat");
  const retry = await screen.findByRole("button", { name: "Retry" });
  expect(screen.getByRole("alert").textContent).toContain(
    "Could not open the bot's chat."
  );
  expect(
    screen.queryByRole("textbox", { name: /Message Chief of Staff/ })
  ).toBeNull();
  expect(app.calls.some(([name]) => name === "ai.send")).toBe(false);
  fireEvent.click(retry);
  await waitFor(() => expect(defaultMode).toHaveBeenCalledTimes(2));
  expect(
    screen.queryByRole("textbox", { name: /Message Chief of Staff/ })
  ).toBeNull();
  expect(app.calls.some(([name]) => name === "ai.send")).toBe(false);
  await act(async () => {
    resolve("DEFAULT" as never);
  });
  const input = await screen.findByRole("textbox", {
    name: /Message Chief of Staff/,
  });
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  fireEvent.change(input, { target: { value: "Hello after retry" } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
  await waitFor(() =>
    expect(app!.calls.some(([name]) => name === "ai.send")).toBe(true)
  );
  const sent = app.calls.find(([name]) => name === "ai.send")![1] as {
    forwardedProps: { mode: string };
  };
  expect(sent.forwardedProps.mode).toBe("DEFAULT");
});
it("buffers completion notices until both mounted watcher snapshots are ready", async () => {
  let releaseBots!: () => void, releaseRoutines!: () => void;
  app = await renderApp("/settings/general", {
    beforeRender: (db) => {
      releaseBots = db.bots.holdSnapshot();
      releaseRoutines = db.routines.holdSnapshot();
    },
    runFinished: async function* () {
      yield {
        threadId: "background",
        runId: "early",
        owner: {
          kind: "bot",
          botId: "chief-of-staff",
          role: "forever",
          key: "forever",
        },
        routineId: null,
        at: 1,
        outcome: "success",
        hasVisibleAssistantText: true,
      };
      await new Promise(() => {});
    },
  });
  await act(async () => {
    await new Promise((done) => setTimeout(done, 20));
  });
  expect(botsUnreadStore.has("chief-of-staff")).toBe(false);
  await act(async () => {
    releaseBots();
  });
  expect(botsUnreadStore.has("chief-of-staff")).toBe(false);
  await act(async () => {
    releaseRoutines();
  });
  await waitFor(() => expect(botsUnreadStore.has("chief-of-staff")).toBe(true));
});
it("automatic URL deliverables retain their destination through the routed session browser handoff", async () => {
  const external = vi.fn();
  const unregister = () => {};
  try {
    app = await renderApp("/bots/chief-of-staff", {
      seed: {
        ...defaultSeed(),
        sessions: [
          {
            ...fixtureSessions()[0]!,
            id: "bot-test",
            workspaceId: "default",
            owner: {
              kind: "bot",
              botId: "chief-of-staff",
              role: "forever",
              key: "forever",
            },
          },
        ],
      },
      filesEvents: async function* () {
        yield { type: "preview-open", path: "https://example.test/report" };
        await new Promise(() => {});
      },
      openExternal: external,
    });
    await screen.findByDisplayValue("https://example.test/report");
    await waitFor(() =>
      expect(app!.calls).toContainEqual([
        "browser.runtime.materialize",
        expect.objectContaining({
          resourceId: expect.stringMatching(/^browser:/),
          url: "https://example.test/report",
          conversationKey: JSON.stringify([
            "conversation",
            1,
            "default",
            "session",
            "bot-test",
          ]),
        }),
      ])
    );
    expect(external).not.toHaveBeenCalled();
    await act(async () => {
      requestBrowserOpen({ sessionId: "other", url: "https://other.test" });
    });
    expect(screen.queryByDisplayValue("https://other.test")).toBeNull();
  } finally {
    unregister();
  }
});

it("hover-then-click blocks mounting the preload result until open and hydration finish", async () => {
  let releaseOpen!: () => void, releaseHydrate!: () => void;
  const opened = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const hydrated = new Promise<void>((resolve) => {
    releaseHydrate = resolve;
  });
  app = await renderApp("/bots/new", {
    beforeOpenChat: () => opened,
    beforeHydrate: () => hydrated,
  });
  await app.router.preloadRoute({
    to: "/bots/$botId",
    params: { botId: "chief-of-staff" },
  });
  expect(app.calls.filter(([name]) => name === "bots.openChat")).toHaveLength(
    0
  );
  fireEvent.click(screen.getByRole("link", { name: /Chief of Staff,/ }));
  await waitFor(() =>
    expect(app!.calls.some(([name]) => name === "bots.openChat")).toBe(true)
  );
  expect(screen.queryByTestId("bot-chat")).toBeNull();
  await act(async () => {
    releaseOpen();
  });
  expect(screen.queryByTestId("bot-chat")).toBeNull();
  await act(async () => {
    releaseHydrate();
  });
  await screen.findByTestId("bot-chat", {}, { timeout: 5000 });
});
it("Back to files clears sender preview and restores the files list", async () => {
  app = await renderApp(
    "/bots/chief-of-staff/chats/sender?tab=files&preview=%2Fw%2Fa.md",
    {
      seed: {
        ...defaultSeed(),
        sessions: [
          {
            ...fixtureSessions()[0]!,
            id: "sender",
            workspaceId: "default",
            owner: {
              kind: "bot",
              botId: "chief-of-staff",
              role: "sender",
              key: "sender",
            },
          },
        ],
      },
    }
  );
  fireEvent.click(await screen.findByRole("button", { name: "Back to files" }));
  await waitFor(() =>
    expect(app!.router.state.location.search.preview).toBeUndefined()
  );
  await waitFor(() =>
    expect(document.querySelector('[data-slot="file-preview"]')).toBeNull()
  );
});

it.each(["pdf", "html"])(
  "the routed guest %s preview resolves through the host file boundary",
  async (extension) => {
    const materializeFile = vi.fn(
      async (
        input: import("@abacus-ai/contract/contract/browser").MaterializeBrowserRuntimeFileRequest
      ) => ({
        lease: {
          conversationKey: input.conversationKey,
          resourceId: input.resourceId,
          generation: 1,
        },
        url: `file:///host/report.${extension}`,
        title: "report",
        loading: false,
        canGoBack: false,
        canGoForward: false,
        focused: false,
        crashed: false,
        devToolsOpen: false,
        zoomFactor: 1,
      })
    );
    app = await renderApp(
      `/bots/chief-of-staff?tab=files&preview=%2Fworkspace%2Freport.${extension}`,
      {
        seed: {
          ...defaultSeed(),
          bots: [
            {
              ...fixtureBots()[0]!,
              sessionId: "bot-test",
              workspaceId: "abacusai-bot",
            },
          ],
          sessions: [
            {
              ...fixtureSessions()[0]!,
              id: "bot-test",
              workspaceId: "abacusai-bot",
              owner: {
                kind: "bot",
                botId: "chief-of-staff",
                role: "forever",
                key: "forever",
              },
            },
          ],
        },
        materializeFile,
      }
    );
    await screen.findByTestId("bot-chat");
    await waitFor(() =>
      expect(document.querySelector("webview")?.getAttribute("src")).toBe(
        `file:///host/report.${extension}${extension === "pdf" ? "#view=FitH" : ""}`
      )
    );
    expect(materializeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: `/workspace/report.${extension}`,
        hostRoot: "/Users/you/code/abacusai-bot",
      })
    );
  }
);
