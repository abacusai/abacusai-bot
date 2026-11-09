import { contract } from "@abacus-ai/contract/contract";
import { OPENLLM_ID } from "@abacus-ai/contract/models";
/**
 * R2-T14 (§5.5): sub-agent rows, Stop = `ai.cancel` of the parent run
 * (never `handle.stop`), Open → `onOpenSubagent`. R2-T15 (§5.6): busy line
 * labels, run marker duration and steps, outcome records at their anchor
 * for a pre-output cancellation and a message-free failure after reload,
 * notices deduplicated. R2-T21 (§8.5) rendered: rejections show their text.
 */
import { implement } from "@orpc/server";
import type { StreamChunk } from "@tanstack/ai";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMemoryTransport } from "#renderer/data/transport/memory";
import {
  FREE_CREDITS_POLL_LIMIT_MS,
  FREE_CREDITS_POLL_MS,
  freeCreditsPolling,
  resetFreeCreditsWatch,
  startFreeCreditsWatch,
} from "#renderer/lib/free-credits-watch";
import {
  closeUpgradeDialog,
  upgradeDialogStore,
} from "#renderer/lib/upgrade-dialog";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { hostActionsFor, inertHostActions } from "../runtime/host-actions";
import { emptyThreadState } from "../store/thread-store";
import { renderRelay, renderScenario } from "../testing";
import {
  busyLabel,
  longToolLabel,
  noteRunningCalls,
  runningCallKey,
} from "./status/status";

let current: { cleanup(): Promise<void> } | null = null;
afterEach(async () => {
  await current?.cleanup();
  current = null;
});

const t = (key: string, values?: Record<string, unknown>) =>
  `${key}${values != null ? JSON.stringify(values) : ""}`;

/**
 * A tool running past a minute reads in plain words with its own time, not
 * as a raw shell line: "du -a . | sort -rn | head" told a non-technical user
 * nothing through a 10-minute scan.
 */
describe("a long-running tool on the busy line", () => {
  const running = (
    ...calls: Array<[id: string, name: string, input?: object]>
  ) =>
    [
      {
        id: "a1",
        role: "assistant",
        parts: calls.map(([id, name, input = {}]) => ({
          type: "tool-call",
          id,
          name,
          input,
          arguments: JSON.stringify(input),
          state: "input-complete",
        })),
      },
    ] as never;
  const plain = (key: string, values?: Record<string, unknown>) =>
    key === "chat.busy.longTool"
      ? `${String(values?.activity)} · ${String(values?.minutes)} min`
      : key === "chat.busy.activity.command"
        ? "Running a command"
        : key;

  /** The busy line's effect: each newly running call's clock starts at `now`. */
  const seen = (messages: never, now: number) =>
    noteRunningCalls(runningCallKey(messages), now);

  it("names the kind, with the tool's own minutes, once it passes a minute", () => {
    const messages = running([
      "du1",
      "bash",
      { command: "du -a . | sort -rn" },
    ]);
    // Before the effect has started its clock, nothing is claimed.
    expect(longToolLabel(plain, messages, 10 * 60_000)).toBeNull();
    seen(messages, 0);
    expect(longToolLabel(plain, messages, 0)).toBeNull();
    expect(longToolLabel(plain, messages, 59_000)).toBeNull();
    expect(longToolLabel(plain, messages, 60_000)).toBe(
      "Running a command · 1 min"
    );
    expect(longToolLabel(plain, messages, 4 * 60_000 + 5_000)).toBe(
      "Running a command · 4 min"
    );
    // A new call starts its own clock.
    const next = running(["du2", "bash", { command: "find . -size +1G" }]);
    seen(next, 5 * 60_000);
    expect(longToolLabel(plain, next, 5 * 60_000 + 30_000)).toBeNull();
    expect(longToolLabel(plain, next, 6 * 60_000)).toBe(
      "Running a command · 1 min"
    );
  });

  it("keeps a tool's own title where it has no plain phrase", () => {
    const messages = running(["g1", "gmail_search", { query: "invoices" }]);
    seen(messages, 0);
    expect(longToolLabel(plain, messages, 2 * 60_000)).toMatch(/ · 2 min$/);
    expect(longToolLabel(plain, messages, 2 * 60_000)).not.toMatch(/^Running/);
  });

  it("leaves several running tools to the count", () => {
    const messages = running(["x1", "bash"], ["x2", "bash"]);
    seen(messages, 0);
    expect(longToolLabel(plain, messages, 5 * 60_000)).toBeNull();
  });
});

describe("R2-T15 status", () => {
  it("busy line labels", () => {
    const state = emptyThreadState();
    expect(busyLabel(t, { state, running: ["Run npm test"], agents: 0 })).toBe(
      "Run npm test"
    );
    expect(busyLabel(t, { state, running: ["a", "b"], agents: 0 })).toBe(
      'chat.busy.tools{"count":2}'
    );
    expect(busyLabel(t, { state, running: [], agents: 3 })).toBe(
      'chat.busy.agents{"count":3}'
    );
    expect(
      busyLabel(t, {
        state: {
          ...state,
          activity: {
            ...state.activity,
            retry: {
              attempt: 2,
              maxAttempts: 5,
              delayMs: 1,
              isNetworkError: false,
              waitingForConnection: false,
            },
          },
        },
        running: [],
        agents: 0,
      })
    ).toBe('chat.busy.retrying{"attempt":2,"max":5}');
    expect(
      busyLabel(t, {
        state: {
          ...state,
          activity: {
            ...state.activity,
            retry: {
              attempt: 3,
              maxAttempts: 0,
              delayMs: 8_000,
              isNetworkError: true,
              waitingForConnection: true,
            },
          },
        },
        running: [],
        agents: 0,
      })
    ).toBe("chat.busy.waitingForConnection");
    expect(
      busyLabel(t, {
        state: {
          ...state,
          permissions: { items: [{} as never], answering: {} },
        },
        running: [],
        agents: 0,
      })
    ).toBe("chat.busy.needsYou");
    expect(busyLabel(t, { state, running: [], agents: 0 })).toBe(
      "chat.busy.working"
    );
  });

  it("run marker: duration and steps (sessions)", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r1", { timestamp: 1_000 }),
      ...b.text("u1", "user", "go"),
      b.textStart("a1"),
      ...b.toolCall("c1", "read", "a1", { path: "a" }),
      b.toolResult("c1", { text: "x" }),
      ...b.toolCall("c2", "read", "a1", { path: "b" }),
      b.toolResult("c2", { text: "y" }),
      b.textEnd("a1"),
      b.runFinished("r1", "success", { timestamp: 49_000 }),
    ]);
    current = await renderRelay(relay, "session");
    expect(await screen.findByText("Done in 48.0s, 2 steps")).toBeTruthy();
  });

  it("outcomes at their anchors after reload: cancelled before output, failure with no message", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r1"),
      ...b.text("u1", "user", "first"),
      b.runFinished("r1", "cancelled"),
      b.runStarted("r2"),
      ...b.text("u2", "user", "second"),
      ...b.text("r2:error", "assistant", ""),
      b.runError("r2", { message: "The model provider had a problem (400)." }),
    ]);
    current = await renderRelay(relay, "session");
    expect(await screen.findByText("Stopped")).toBeTruthy();
    expect(
      screen.getByText("The model provider had a problem (400).")
    ).toBeTruthy();
    const log = screen.getByRole("log");
    const order = [
      ...log.querySelectorAll(
        "[data-message-id], [data-slot=run-marker], [data-slot=error-card]"
      ),
    ].map(
      (node) =>
        node.getAttribute("data-message-id") ?? node.getAttribute("data-slot")
    );
    expect(order.indexOf("run-marker")).toBeGreaterThan(order.indexOf("u1"));
    expect(order.indexOf("error-card")).toBeGreaterThan(order.indexOf("u2"));
  });

  it("notices are deduplicated by key", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.custom("agent.notification", {
        severity: "info",
        message: "one",
        notificationKey: "k",
      }),
      b.custom("agent.notification", {
        severity: "info",
        message: "two",
        notificationKey: "k",
      }),
    ]);
    current = await renderRelay(relay, "session");
    expect(await screen.findByText("two")).toBeTruthy();
    expect(screen.queryByText("one")).toBeNull();
  });
});

describe("abacus.notice (main's own history notice)", () => {
  it("renders the too-large history notice from the snapshot, and reveals its path through system.showItemInFolder", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.custom("abacus.notice", {
        kind: "too-large",
        size: 600 * 1024 ** 2,
        limit: 512 * 1024 ** 2,
        notificationKey: "abacus.history",
        path: "/home/.abacusai-bot/transcripts/t-1.json",
      }),
    ]);
    const show = vi.fn();
    const impl = implement(contract);
    const transport = createMemoryTransport(
      {
        system: {
          showItemInFolder: impl.system.showItemInFolder.handler(
            ({ input }) => {
              show(input);
            }
          ),
        },
      },
      {}
    );
    const rendered = await renderRelay(
      relay,
      "session",
      {},
      {},
      hostActionsFor(transport)
    );
    current = {
      cleanup: async () => {
        await rendered.cleanup();
        await transport.close();
      },
    };
    expect(
      await screen.findByText(
        "Earlier history is too large to show here (600 MB, the limit is 512 MB)."
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    await waitFor(() =>
      expect(show).toHaveBeenCalledExactlyOnceWith({
        path: "/home/.abacusai-bot/transcripts/t-1.json",
      })
    );
  });

  it("says the chat is not being saved on a full disk, and drops the line once main takes it back", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.custom("abacus.notice", {
        kind: "unsaved",
        notificationKey: "abacus.unsaved",
      }),
    ]);
    current = await renderRelay(relay, "session");
    const line =
      "The disk is full, so this chat isn't being saved. Free some space; it's saved again with your next message.";
    expect(await screen.findByText(line)).toBeTruthy();
    relay.emit(
      b.custom("abacus.notice", {
        kind: "unsaved",
        notificationKey: "abacus.unsaved",
        cleared: true,
      })
    );
    await waitFor(() => expect(screen.queryByText(line)).toBeNull());
  });

  it("renders the foreign history notice, with no Show in folder", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.custom("abacus.notice", {
        kind: "foreign",
        notificationKey: "abacus.history",
      }),
    ]);
    current = await renderRelay(relay, "session");
    expect(
      await screen.findByText(
        "This conversation was saved by a newer version of the app, so some of it may not show here."
      )
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show in folder" })).toBeNull();
  });
});

describe("R2-T14 sub-agents", () => {
  it("Stop cancels the parent run; Open opens the agent", async () => {
    const onOpenSubagent = vi.fn();
    const rendered = await renderScenario("session-subagents", {
      onOpenSubagent,
    });
    current = rendered;
    const rows = await waitFor(() => {
      const found = document.querySelectorAll<HTMLElement>(
        '[data-slot="subagent-row"]'
      );
      expect(found).toHaveLength(3);
      return found;
    });
    fireEvent.click(
      within(rows[0]!).getByRole("button", { name: "Open agent" })
    );
    expect(onOpenSubagent).toHaveBeenCalledWith("sub-1");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(rendered.fixture.relay.stats.cancel).toEqual([{ runId: "r1" }])
    );
  });
});

describe("R2-T21 queue (rendered)", () => {
  it("a drained entry's edit shows it already went out; a respawn's shows the restart", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r1"),
      ...b.text("u1", "user", "go"),
      b.custom("queue.updated", {
        messages: [{ id: "q-1", message: "later", waitingFor: "turn" }],
        dequeued: null,
      }),
    ]);
    current = await renderRelay(relay, "session");
    await screen.findByText("later");
    relay.emit(
      b.custom("queue.command_rejected", {
        incarnation: "inc-1",
        entryId: "q-1",
        command: "update",
        reason: "not_found",
      }) as StreamChunk
    );
    expect(
      await screen.findByText("That message already went out")
    ).toBeTruthy();
    relay.emit(
      b.custom("queue.command_rejected", {
        incarnation: "inc-1",
        entryId: "q-1",
        command: "update",
        reason: "incarnation",
      })
    );
    expect(
      await screen.findByText("The agent restarted, so the queue changed")
    ).toBeTruthy();
  });
});

it("read-only bot chats hide retry and named model switches", async () => {
  const relay = new FakeRelay();
  relay.emitAll([
    ...b.sessionReady(),
    b.runStarted("dead"),
    ...b.text("ask", "user", "go"),
    b.runError("dead", {
      message: "Turn failed",
      actions: [
        { type: "retry" },
        {
          type: "switch-model",
          model: OPENLLM_ID,
          label: "RouteLLM - Open",
        },
      ],
    }),
  ]);
  current = await renderRelay(relay, "bot", {
    readOnly: { reason: "Read only" },
    model: { value: "a", label: "A", onChange: vi.fn(), groups: [] },
  });
  await screen.findByText("Turn failed");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Continue on/ })).toBeNull();
  expect(relay.stats.send).toHaveLength(0);
});

it("re-runs a bot's hidden first turn when there is no visible user message", async () => {
  const relay = new FakeRelay();
  relay.emitAll([
    ...b.sessionReady(),
    b.runStarted("first-run"),
    b.runError("first-run", { message: "The provider stopped" }),
  ]);
  current = await renderRelay(relay, "bot");
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(relay.stats.send).toHaveLength(1));
  expect(relay.stats.send[0]!.messages.at(-1)).toMatchObject({
    role: "user",
    parts: [{ type: "text", content: "Continue from where you left off" }],
  });
});

describe("the credit wall", () => {
  const wall = (...turn: StreamChunk[]) => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r1"),
      ...b.text("u1", "user", "build the site"),
      ...turn,
      b.runError("r1", {
        message: "Credits exhausted",
        actions: [{ type: "upgrade-abacus" }],
      }),
    ]);
    return relay;
  };
  const renderDeliverables = vi.fn((items: readonly { path: string }[]) => (
    <ul data-testid="ready">
      {items.map((item) => (
        <li key={item.path}>{item.path}</li>
      ))}
    </ul>
  ));

  it("lists what the cut-off turn presented, through the route's card", async () => {
    const relay = wall(
      b.textStart("a1"),
      ...b.toolCall("c1", "present_deliverable", "a1", {
        items: [{ path: "/repo/site/index.html" }],
      }),
      b.toolResult("c1", { text: "Presented." }),
      b.textEnd("a1")
    );
    current = await renderRelay(
      relay,
      "session",
      {},
      {
        slots: { renderDeliverables },
      }
    );
    const ready = await screen.findByTestId("ready");
    expect(ready.textContent).toBe("/repo/site/index.html");
    expect(
      ready.closest('[data-slot="error-card"]')?.getAttribute("data-variant")
    ).toBe("upgrade");
    expect(screen.getByText("What's ready")).toBeTruthy();
  });

  it("shows no ready section when the turn handed nothing over", async () => {
    const relay = wall(
      b.textStart("a1"),
      ...b.toolCall("c1", "bash", "a1", { command: "ls" }),
      b.toolResult("c1", { text: "ok" }),
      b.textEnd("a1")
    );
    current = await renderRelay(
      relay,
      "session",
      {},
      {
        slots: { renderDeliverables },
      }
    );
    await waitFor(() =>
      expect(document.querySelector('[data-slot="credits-card"]')).toBeTruthy()
    );
    expect(screen.queryByTestId("ready")).toBeNull();
    expect(screen.queryByText("What's ready")).toBeNull();
  });
});

describe("the turn's outcome card", () => {
  const BILLING = {
    current: {
      planName: "Free",
      creditsRemaining: 0,
      creditsGranted: 2000,
      freeTierExpiresAt: null,
    },
    plans: [
      {
        plan: "free",
        planName: "Free",
        priceText: "Free",
        features: [],
        creditsPerMonth: 2000,
        current: true,
      },
    ],
    upgrades: [
      {
        plan: "basic",
        planName: "Basic",
        priceText: "$10/mo",
        firstMonthPriceCents: 700,
        priceCents: 1000,
        features: [
          "20,000 credits a month (10x the free tier)",
          "Image and video generation",
        ],
        url: null,
      },
    ],
    topUpUrl: null,
    upgradeInMobileApp: false,
  };
  const failed = (error: Record<string, unknown>) => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r1"),
      ...b.text("u1", "user", "fix the bug"),
      b.runError("r1", error as never),
    ]);
    return relay;
  };
  const host = (tier: "free" | "basic" | "paid", extra = {}) => ({
    ...inertHostActions,
    accountTier: async () => tier,
    billingPlan: async () => BILLING,
    configuredFreeSources: async () => ({ openrouter: true, gemini: true }),
    ...extra,
  });
  const WALL = {
    message: "You're out of Abacus.AI credits.",
    cause: "credits_exhausted",
    actions: [
      { type: "upgrade-abacus", cause: "exhausted" },
      { type: "continue-free", providers: ["openrouter", "gemini"] },
    ],
  };

  it("shows a paying account nothing of the free plan's wall while its plan is still being read", async () => {
    let answer: ((tier: "basic") => void) | null = null;
    const accountTier = () =>
      new Promise<"basic">((resolve) => {
        answer = resolve;
      });
    current = await renderRelay(
      failed(WALL),
      "session",
      {},
      {},
      { ...host("basic"), accountTier }
    );
    await waitFor(() => expect(answer).not.toBeNull());
    expect(screen.queryByText(/free credits are used up/)).toBeNull();
    answer!("basic");
    expect(await screen.findByText(/this month's credits/)).toBeTruthy();
    expect(screen.queryByText(/free credits/)).toBeNull();
  });

  it("a free account at the wall: the stopped task by name, the plan's whole offer, Upgrade to checkout, then the message goes again", async () => {
    const openUpgrade = vi.fn(async () => {});
    const relay = failed(WALL);
    current = await renderRelay(
      relay,
      "session",
      {},
      {},
      host("free", { openUpgrade })
    );

    const title = await screen.findByText(
      "“fix the bug” is paused: your free credits are used up"
    );
    const wall = title.closest('[data-slot="error-card"]') as HTMLElement;
    expect(wall.getAttribute("data-variant")).toBe("upgrade");
    // The plan's whole offer, never a lone button.
    expect(await within(wall).findByText("Basic gets you:")).toBeTruthy();
    expect(within(wall).getByText("Image and video generation")).toBeTruthy();
    expect(
      within(wall).getByText(
        "Upgrade and it picks up where it stopped, by itself."
      )
    ).toBeTruthy();
    // Nothing ran on a free model before the choice.
    expect(relay.stats.send).toHaveLength(0);

    // Upgrade opens checkout itself; the dialog waits for the plan.
    fireEvent.click(
      within(wall).getByRole("button", { name: "Upgrade · $7 first month" })
    );
    expect(openUpgrade).toHaveBeenCalledOnce();
    const request = upgradeDialogStore.state.request;
    expect(request).toMatchObject({
      kind: "credits",
      checkout: true,
      pendingText: "fix the bug",
    });
    // Once the plan is active the stopped message goes again.
    await request?.resume?.();
    await waitFor(() => expect(relay.stats.send).toHaveLength(1));
    closeUpgradeDialog();

    // See plans: the dialog with every plan, no checkout yet.
    fireEvent.click(within(wall).getByRole("button", { name: "See plans" }));
    expect(upgradeDialogStore.state.request).toMatchObject({
      kind: "credits",
    });
    expect(upgradeDialogStore.state.request?.checkout).toBeUndefined();
    closeUpgradeDialog();
  });

  it("the free models at the wall stay an explicit choice beside the offer", async () => {
    const chooseFreeLane = vi.fn(async () => {});
    const relay = failed(WALL);
    current = await renderRelay(
      relay,
      "session",
      {},
      {},
      host("free", { chooseFreeLane })
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Continue with free models (lower quality)",
      })
    );
    await waitFor(() => expect(relay.stats.send).toHaveLength(1));
    expect(chooseFreeLane).toHaveBeenCalledOnce();
    expect(relay.stats.send[0]!.forwardedProps).toMatchObject({
      model: OPENLLM_ID,
    });
  });

  it("a wall after a short follow-up names the task it was going on with; the wall above it is history", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r0"),
      ...b.text(
        "u0",
        "user",
        "Build my bakery website with an online order form"
      ),
      ...b.text("r0:error", "assistant", ""),
      b.runError("r0", WALL as never),
      b.runStarted("r1"),
      ...b.text("u1", "user", "continue"),
      ...b.text("r1:error", "assistant", ""),
      b.runError("r1", WALL as never),
    ]);
    current = await renderRelay(relay, "session", {}, {}, host("free"));
    const title =
      "“Build my bakery website with an online order form” is paused: your free credits are used up";
    await screen.findByRole("button", { name: "Upgrade · $7 first month" });
    const cards = [
      ...document.querySelectorAll('[data-slot="error-card"]'),
    ] as HTMLElement[];
    expect(cards.map((card) => card.getAttribute("data-variant"))).toEqual([
      "upgrade-history",
      "upgrade",
    ]);
    expect(cards[0]!.textContent).toBe(title);
    expect(within(cards[1]!).getByText(title)).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Upgrade · $7 first month" })
    ).toHaveLength(1);
  });

  it.each([
    ["while it runs", [b.runStarted("r1")]],
    [
      "once it answered",
      [
        b.runStarted("r1"),
        ...b.text("a1", "assistant", "Here is the bakery site."),
        b.runFinished("r1", "success"),
      ],
    ],
  ])("a resumed turn clears the wall it answers %s", async (_name, events) => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r0"),
      ...b.text("u0", "user", "Build my bakery website"),
      ...b.text("r0:error", "assistant", ""),
      b.runError("r0", WALL as never),
      ...events,
    ]);
    current = await renderRelay(relay, "session", {}, {}, host("free"));
    await screen.findByText("Build my bakery website");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector('[data-slot="error-card"]')).toBeNull();
  });

  it("a routine run at the wall (read-only) still carries the offer: Upgrade goes to checkout, nothing is resent", async () => {
    const relay = failed(WALL);
    current = await renderRelay(
      relay,
      "bot",
      { readOnly: { reason: "Read only" } },
      {},
      host("free")
    );
    const title = await screen.findByText(
      "“fix the bug” is paused: your free credits are used up"
    );
    const wall = title.closest('[data-slot="error-card"]') as HTMLElement;
    expect(
      await within(wall).findByText("Image and video generation")
    ).toBeTruthy();
    expect(within(wall).queryByText(/picks up where it stopped/)).toBeNull();
    expect(
      within(wall).queryByRole("button", { name: /Continue with free/ })
    ).toBeNull();
    fireEvent.click(
      within(wall).getByRole("button", { name: "Upgrade · $7 first month" })
    );
    expect(upgradeDialogStore.state.request).toMatchObject({
      kind: "plan",
      checkout: true,
    });
    expect(upgradeDialogStore.state.request?.resume).toBeUndefined();
    closeUpgradeDialog();
    expect(relay.stats.send).toHaveLength(0);
  });

  it("an expired free tier says so, and its See plans asks for the expired dialog", async () => {
    current = await renderRelay(
      failed({
        message: "Your free credits have expired.",
        cause: "credits_expired",
        actions: [{ type: "upgrade-abacus", cause: "expired" }],
      }),
      "session",
      {},
      {},
      host("free")
    );
    await screen.findByText(
      "“fix the bug” is paused: your free credits have expired"
    );
    fireEvent.click(await screen.findByRole("button", { name: "See plans" }));
    expect(upgradeDialogStore.state.request).toMatchObject({
      kind: "credits",
      expired: true,
    });
    closeUpgradeDialog();
  });

  const PRO_TIER = {
    plan: "pro",
    planName: "Pro",
    priceText: "$20/mo",
    firstMonthPriceCents: 2000,
    priceCents: 2000,
    features: ["Everything in Basic", "30,000 credits a month"],
    url: "https://example.com/upgrade/pro",
  };
  const BASIC_BILLING = {
    ...BILLING,
    current: { ...BILLING.current, plan: "basic", planName: "Basic" },
    plans: [],
    upgrades: [PRO_TIER],
    topUpUrl: "https://example.com/plans?buyCredits=true",
  };
  const PRO_BILLING = {
    ...BASIC_BILLING,
    current: { ...BILLING.current, plan: "pro", planName: "Pro" },
    upgrades: [
      {
        plan: "max",
        planName: "Max",
        priceText: "$200/mo",
        priceCents: 20000,
        features: ["Everything in Pro", "300,000 credits a month"],
        url: "https://example.com/upgrade/max",
      },
    ],
  };

  it("Basic at the wall gets the free plan's offer for Pro: Upgrade goes to Pro's checkout, no Top up", async () => {
    const openTopUp = vi.fn(async () => {});
    const openNextPlan = vi.fn(async () => {});
    current = await renderRelay(
      failed(WALL),
      "session",
      {},
      {},
      host("basic", {
        canTopUpCredits: async () => true,
        openTopUp,
        openNextPlan,
        billingPlan: async () => BASIC_BILLING,
      })
    );
    const title = await screen.findByText(
      "“fix the bug” is paused: this month's credits are used up"
    );
    const wall = title.closest('[data-slot="error-card"]') as HTMLElement;
    expect(within(wall).queryByRole("button", { name: "Top up" })).toBeNull();
    expect(await within(wall).findByText("Pro gets you:")).toBeTruthy();

    fireEvent.click(within(wall).getByRole("button", { name: /^Upgrade/ }));
    expect(openNextPlan).toHaveBeenCalledOnce();
    expect(upgradeDialogStore.state.request).toMatchObject({
      kind: "credits",
      checkout: true,
      pendingText: "fix the bug",
    });
    expect(openTopUp).not.toHaveBeenCalled();
    closeUpgradeDialog();
  });

  it("Pro at the wall is offered a top-up and Max, never the free plan's pitch", async () => {
    const openTopUp = vi.fn(async () => {});
    const openNextPlan = vi.fn(async () => {});
    current = await renderRelay(
      failed(WALL),
      "session",
      {},
      {},
      host("paid", {
        canTopUpCredits: async () => true,
        openTopUp,
        openNextPlan,
        billingPlan: async () => PRO_BILLING,
      })
    );
    await screen.findByText(
      "“fix the bug” is paused: this month's credits are used up"
    );
    expect(
      await screen.findByText("Or move up to Max — $200/month")
    ).toBeTruthy();
    expect(screen.getByText("300,000 credits a month")).toBeTruthy();

    // Top up opens the link and the dialog waits for the credits, then resends.
    fireEvent.click(screen.getByRole("button", { name: "Top up" }));
    expect(openTopUp).toHaveBeenCalledOnce();
    expect(upgradeDialogStore.state.request).toMatchObject({
      kind: "credits",
      checkout: true,
      pendingText: "fix the bug",
    });
    closeUpgradeDialog();

    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    expect(openNextPlan).toHaveBeenCalledOnce();
    expect(upgradeDialogStore.state.request).toMatchObject({
      kind: "credits",
      checkout: true,
    });
    closeUpgradeDialog();
  });

  it("free credits held for a phone check: one card, Verify phone opens the page, no plan", async () => {
    const openExternal = vi.fn(async () => {});
    const openUpgrade = vi.fn(async () => {});
    current = await renderRelay(
      failed({
        message: "Verify your phone to unlock 2,000 free credits.",
        cause: "phone_verification",
        actions: [
          {
            type: "verify-phone",
            link: "https://apps.abacus.ai/bot/link/verify-phone",
            credits: "2,000",
          },
        ],
      }),
      "session",
      {},
      {},
      host("free", { openExternal, openUpgrade })
    );
    await screen.findByText("Verify your phone to unlock 2,000 free credits");
    screen.getByRole("button", { name: "Verify phone" }).click();
    expect(openExternal).toHaveBeenCalledWith(
      "https://apps.abacus.ai/bot/link/verify-phone"
    );
    expect(openUpgrade).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Upgrade/ })).toBeNull();
  });

  describe("free credits held, then unlocked", () => {
    const VERIFY = {
      message: "Verify your phone to unlock 2,000 free credits.",
      cause: "phone_verification",
      actions: [
        {
          type: "verify-phone",
          link: "https://apps.abacus.ai/bot/link/verify-phone",
          credits: "2,000",
        },
      ],
    };
    const ACCOUNT = {
      user_id: "u1",
      organization_id: "o1",
      name: null,
      email: null,
      picture: null,
      organization: null,
      org_user_count: null,
      plan: "Free",
      subscription_tier: "free",
      credits_used: 0,
      credits_granted: 2000,
    };
    const served = (state: { account: Record<string, unknown> }) => {
      const os = implement(contract);
      return {
        account: {
          abacus: os.account.abacus.handler(() => state.account as never),
          payment: os.account.payment.handler(() => null),
        },
      };
    };
    afterEach(() => resetFreeCreditsWatch());

    it("turns in place once the account says unlocked, and Send again sends the message again", async () => {
      const openExternal = vi.fn(async () => {});
      const state = { account: { ...ACCOUNT, free_credits_held: true } };
      const relay = failed(VERIFY);
      current = await renderRelay(
        relay,
        "session",
        {},
        {},
        host("free", { openExternal }),
        served(state)
      );
      await screen.findByText("Verify your phone to unlock 2,000 free credits");
      fireEvent.click(screen.getByRole("button", { name: "Verify phone" }));
      expect(openExternal).toHaveBeenCalledWith(
        "https://apps.abacus.ai/bot/link/verify-phone"
      );
      // Still held: coming back to the window reads it again, and it still asks.
      window.dispatchEvent(new Event("focus"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.getByRole("button", { name: "Verify phone" })).toBeTruthy();
      state.account = { ...ACCOUNT, free_credits_held: false };
      window.dispatchEvent(new Event("focus"));
      expect(
        await screen.findByText("2,000 free credits unlocked")
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Verify phone" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Send again" }));
      await waitFor(() => expect(relay.stats.send).toHaveLength(1));
      expect(relay.stats.send[0]!.messages.at(-1)).toMatchObject({
        role: "user",
        parts: [{ type: "text", content: "fix the bug" }],
      });
    });

    it("shows the unlock on the first read when it happened elsewhere", async () => {
      current = await renderRelay(
        failed(VERIFY),
        "session",
        {},
        {},
        host("free"),
        served({ account: { ...ACCOUNT, free_credits_held: false } })
      );
      expect(
        await screen.findByText("2,000 free credits unlocked")
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Verify phone" })).toBeNull();
    });

    it("keeps asking on a server that does not say", async () => {
      current = await renderRelay(
        failed(VERIFY),
        "session",
        {},
        {},
        host("free"),
        served({ account: ACCOUNT })
      );
      await screen.findByText("Verify your phone to unlock 2,000 free credits");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByText(/free credits unlocked/)).toBeNull();
      expect(screen.getByRole("button", { name: "Verify phone" })).toBeTruthy();
    });

    it("polls only while held, for ten minutes after Verify", () => {
      const held = { ...ACCOUNT, free_credits_held: true };
      expect(freeCreditsPolling(held, 0)).toBe(false);
      startFreeCreditsWatch(0);
      expect(FREE_CREDITS_POLL_MS).toBe(10_000);
      expect(freeCreditsPolling(held, FREE_CREDITS_POLL_LIMIT_MS - 1)).toBe(
        true
      );
      expect(freeCreditsPolling(held, FREE_CREDITS_POLL_LIMIT_MS)).toBe(false);
      expect(
        freeCreditsPolling({ ...ACCOUNT, free_credits_held: false }, 1)
      ).toBe(false);
      expect(freeCreditsPolling(ACCOUNT, 1)).toBe(false);
    });
  });

  it("Abacus's billing gate is a payment card: support, the billing page, no purchase", async () => {
    const openExternal = vi.fn(async () => {});
    const openUpgrade = vi.fn(async () => {});
    current = await renderRelay(
      failed({
        message: "We couldn't confirm your last payment.",
        cause: "payment_required",
        actions: [
          { type: "payment-required", cause: "unconfirmed" },
          { type: "switch-model" },
        ],
      }),
      "session",
      {},
      {},
      host("free", { openExternal, openUpgrade })
    );
    await screen.findByText("We couldn't confirm your last payment");
    expect(
      screen.getByText(
        "If your subscription is active, contact support@abacus.ai. Please don't purchase again."
      )
    ).toBeTruthy();
    screen.getByRole("button", { name: "Open billing" }).click();
    expect(openExternal).toHaveBeenCalledWith(
      "https://apps.abacus.ai/chatllm/admin/profile"
    );
    expect(openUpgrade).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Upgrade/ })).toBeNull();
    expect(
      screen.queryByText(/used your free credits|out of credits/i)
    ).toBeNull();
  });

  it("a dropped connection is the connection card, with its details and a retry", async () => {
    current = await renderRelay(
      failed({
        message:
          "Connection problem — check your internet connection, VPN, or proxy.",
        code: "network_unreachable",
        cause: "connection",
        detail: "Connection error.",
        actions: [{ type: "retry" }],
      }),
      "session"
    );
    await screen.findByText("Connection problem");
    expect(
      screen.getByText(
        "Check your internet connection, VPN, or proxy and try again."
      )
    ).toBeTruthy();
    expect(screen.getByText("View details")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText(/busy/)).toBeNull();
  });

  it("a full disk says so, with the space left, and offers Retry rather than another model", async () => {
    current = await renderRelay(
      failed({
        message: "The disk is full.",
        code: "turn_failed",
        cause: "disk_full",
        actions: [{ type: "retry", bytesFree: 12 * 1024 ** 2 }],
      }),
      "session"
    );
    await screen.findByText(
      "The disk is full (12 MB left), so this chat can't be saved and the agent can't write files. Free some space, then try again."
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(/different model/)).toBeNull();
  });

  it("a run the app closed under reads Interrupted, not a crash; a chat can retry it, a report cannot", async () => {
    const rows: Array<
      [string, Parameters<typeof renderRelay>[2], boolean, boolean]
    > = [
      // [code, composer, interrupted marker, Retry]
      ["app_closed", undefined, true, true],
      ["app_closed", { readOnly: { reason: "A run" } }, true, false],
      ["agent_exit", { readOnly: { reason: "A run" } }, false, false],
    ];
    for (const [code, composer, interrupted, retry] of rows) {
      current = await renderRelay(
        failed({ message: "The app closed before the reply finished.", code }),
        "session",
        composer
      );
      await waitFor(() =>
        expect(
          document.querySelector(
            "[data-slot=run-marker], [data-slot=error-card]"
          )
        ).not.toBeNull()
      );
      expect(screen.queryByText("Interrupted") != null).toBe(interrupted);
      expect(screen.queryByText("The agent stopped unexpectedly") != null).toBe(
        !interrupted
      );
      expect(screen.queryByRole("button", { name: "Retry" }) != null).toBe(
        retry
      );
      await current.cleanup();
      current = null;
    }
  });

  it("an outgrown chat offers a new chat", async () => {
    const onNewChat = vi.fn();
    current = await renderRelay(
      failed({
        message: "This conversation is too long for the free models.",
        cause: "context_too_long",
        actions: [{ type: "new-chat" }, { type: "switch-model" }],
      }),
      "session",
      { onNewChat }
    );
    await screen.findByText(
      "This conversation is too long for the model. Start a new chat, or pick a model with a larger context."
    );
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onNewChat).toHaveBeenCalledOnce();
  });

  it("names the provider whose own key hit its quota, with a way to fix it", async () => {
    current = await renderRelay(
      failed({
        message: "Your Gemini key hit its quota.",
        cause: "own_key_quota",
        actions: [
          { type: "switch-model" },
          { type: "fix-key", provider: "gemini" },
        ],
      }),
      "session"
    );
    await screen.findByText(
      "Your Google Gemini key hit its quota. Switch to a different model, or check the key's plan."
    );
    expect(screen.getByText("Check the key")).toBeTruthy();
  });

  it("a rejected own OpenAI key with Abacus credits left names the key and switches the turn to Abacus on one tap", async () => {
    const relay = failed({
      message: "Your OpenAI key was rejected — it's invalid or expired.",
      cause: "key_invalid",
      actions: [
        { type: "fix-key", provider: "openai" },
        { type: "switch-to-abacus" },
      ],
    });
    current = await renderRelay(relay, "session");
    await screen.findByText(
      "Your OpenAI key was rejected — it's invalid or expired."
    );
    expect(screen.getByText("Check the key")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Switch to RouteLLM - Open" })
    );
    await waitFor(() => expect(relay.stats.send).toHaveLength(1));
    expect(relay.stats.send[0]!.forwardedProps).toMatchObject({
      model: OPENLLM_ID,
    });
  });

  // NVIDIA's free Kimi K3 gone (410), as the agent ends that turn.
  const offAbacusError = (credits: boolean, provider = "nvidia") => ({
    message: "This model couldn't take the request. Pick a different model.",
    cause: "model_unavailable",
    detail: "410 status code (no body)",
    actions: [
      {
        type: "own-key-unavailable",
        provider,
        cause: "gone",
        model: `${provider}/moonshotai/kimi-k3`,
        label: "Kimi K3",
        free: true,
      },
      ...(credits ? [{ type: "switch-to-abacus" }] : []),
    ],
  });
  const offAbacus = (credits: boolean, provider = "nvidia") =>
    failed(offAbacusError(credits, provider));
  // The turn fails while the chat is on screen, as UpgradeTriggers sees it.
  const failsLive = async (
    credits: boolean,
    error: Record<string, unknown> = offAbacusError(credits)
  ) => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r1"),
      ...b.text("u1", "user", "fix the bug"),
    ]);
    // A free account on NVIDIA's model: the composer's RouteLLM notice is up for it.
    const model = {
      value: "nvidia/moonshotai/kimi-k3",
      label: "Kimi K3",
      onChange: () => {},
      groups: [],
      otherProvider: {
        model: "Kimi K3",
        provider: "NVIDIA NIM",
        free: true,
        onSwitch: () => {},
      },
    };
    current = await renderRelay(relay, "session", { model }, {}, host("free"));
    relay.emitAll([b.runError("r1", error as never)]);
    return screen.findByText(
      error.cause === "model_unavailable"
        ? "Kimi K3 on NVIDIA NIM isn't available anymore"
        : String(error.message)
    );
  };
  const notice = () =>
    document.querySelector('[data-slot="other-provider-notice"]');

  it("the RouteLLM notice stays down behind a card that offers the switch or the plan; the dialog opens only out of credits", async () => {
    await failsLive(true);
    expect(upgradeDialogStore.state.request).toBeNull();
    // One offer on screen: the card's, never the composer's beside it.
    expect(notice()).toBeNull();
    await current?.cleanup();
    // A turn that ended on a plain error: the notice is the way on.
    await failsLive(true, {
      message: "Something odd happened.",
      code: "turn_failed",
      actions: [{ type: "switch-model" }],
    });
    await waitFor(() => expect(notice()).not.toBeNull());
    await current?.cleanup();
    await failsLive(false);
    await waitFor(() =>
      expect(upgradeDialogStore.state.request).toMatchObject({
        kind: "own-key",
        ownKey: { provider: "nvidia", cause: "gone", label: "Kimi K3" },
      })
    );
    // The full-offer card stands alone: no RouteLLM notice under it.
    expect(notice()).toBeNull();
    closeUpgradeDialog();
  });

  it("a failure that ends before the view catches up still opens the dialog once, naming the model", async () => {
    // A chat of its own: the dialog is offered once per chat.
    const relay = new FakeRelay({ threadId: "t-fast" });
    relay.emitAll(b.sessionReady());
    const rendered = await renderRelay(relay, "session", {}, {}, host("free"));
    current = rendered;
    // The person sends; the provider refuses at once, and the run's end comes
    // in with a fresh snapshot (main restarted under it), not as a live event.
    void rendered.runtime.session(relay.threadId).submit("hi");
    await waitFor(() => expect(relay.stats.send).toHaveLength(1));
    const runId = relay.stats.send[0]!.runId;
    relay.setEpoch("epoch-2");
    relay.faults.subscribe = () => new Error("restarting");
    relay.dropSubscriptions();
    relay.emitAll([
      b.runStarted(runId),
      ...b.text("u1", "user", "hi"),
      b.runError(runId, offAbacusError(false) as never),
    ]);
    relay.faults.subscribe = undefined;
    await screen.findByText("Kimi K3 on NVIDIA NIM isn't available anymore");
    await waitFor(() =>
      expect(upgradeDialogStore.state.request).toMatchObject({
        kind: "own-key",
        ownKey: { provider: "nvidia", cause: "gone", label: "Kimi K3" },
      })
    );
    closeUpgradeDialog();
  });

  it("a new chat's first message that fails at once still opens the dialog, once its hand-off lands", async () => {
    // The run already ended when the view loads: it comes in with the snapshot.
    const relay = new FakeRelay({ threadId: "t-first" });
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("run-first"),
      ...b.text("u1", "user", "hi"),
      b.runError("run-first", offAbacusError(false) as never),
    ]);
    const rendered = await renderRelay(relay, "session", {}, {}, host("free"));
    current = rendered;
    await screen.findByText("Kimi K3 on NVIDIA NIM isn't available anymore");
    expect(upgradeDialogStore.state.request).toBeNull();
    // The new chat's start hand-off names the run this window sent.
    rendered.runtime.session(relay.threadId).noteSent("run-first");
    await waitFor(() =>
      expect(upgradeDialogStore.state.request).toMatchObject({
        kind: "own-key",
        ownKey: { provider: "nvidia", cause: "gone", label: "Kimi K3" },
      })
    );
    closeUpgradeDialog();
  });

  it("a free provider's model that is gone says what failed and why, and switches to RouteLLM - Open while credits are left", async () => {
    const relay = offAbacus(true);
    current = await renderRelay(relay, "session", {}, {}, host("free"));
    const title = await screen.findByText(
      "Kimi K3 on NVIDIA NIM isn't available anymore"
    );
    const card = title.closest('[data-slot="error-card"]') as HTMLElement;
    expect(card.getAttribute("data-variant")).toBe("own-key");
    expect(
      within(card).getByText(
        "NVIDIA NIM's free models can stop answering or be retired without notice. Your message is kept."
      )
    ).toBeTruthy();
    // Plain words: never "not Abacus", never the provider's raw error.
    expect(card.textContent).not.toMatch(/not (?:from |on )?Abacus/);
    expect(within(card).queryByText("410 status code (no body)")).toBeNull();
    expect(within(card).queryByRole("button", { name: /Upgrade/ })).toBeNull();
    expect(relay.stats.send).toHaveLength(0);
    fireEvent.click(
      within(card).getByRole("button", { name: "Switch to RouteLLM - Open" })
    );
    await waitFor(() => expect(relay.stats.send).toHaveLength(1));
    expect(relay.stats.send[0]!.forwardedProps).toMatchObject({
      model: OPENLLM_ID,
    });
  });

  it("the same failure with the credits used up carries the plan's whole offer, never the switch", async () => {
    current = await renderRelay(
      offAbacus(false),
      "session",
      {},
      {},
      host("free")
    );
    const title = await screen.findByText(
      "Kimi K3 on NVIDIA NIM isn't available anymore"
    );
    const card = title.closest('[data-slot="error-card"]') as HTMLElement;
    expect(
      within(card).getByText("You've also used your free Abacus credits.")
    ).toBeTruthy();
    // The same offer every out-of-credits card shows: plan, price, every line.
    expect(await within(card).findByText("Basic gets you:")).toBeTruthy();
    expect(within(card).getByText("Image and video generation")).toBeTruthy();
    expect(
      within(card).getByRole("button", { name: "See plans" })
    ).toBeTruthy();
    expect(
      within(card).queryByRole("button", { name: "Switch to RouteLLM - Open" })
    ).toBeNull();
    fireEvent.click(
      within(card).getByRole("button", { name: "Upgrade · $7 first month" })
    );
    expect(upgradeDialogStore.state.request).toMatchObject({
      kind: "own-key",
      ownKey: { provider: "nvidia", cause: "gone" },
    });
    closeUpgradeDialog();
  });

  it("a paid account keeps AbacusAI Agent on the web, and a local server is named as the user's", async () => {
    current = await renderRelay(
      offAbacus(true, "local"),
      "session",
      {},
      {},
      host("paid")
    );
    const title = await screen.findByText(
      "Kimi K3 on your local model server isn't available anymore"
    );
    const card = title.closest('[data-slot="error-card"]') as HTMLElement;
    expect(
      within(card).getByText(
        "Kimi K3 runs on your local model server, which has to be running and reachable."
      )
    ).toBeTruthy();
    expect(
      within(card).getByRole("button", { name: "Open AbacusAI Agent" })
    ).toBeTruthy();
  });

  // A chat that can start anew and pick its model.
  const chatComposer = {
    onNewChat: () => {},
    model: {
      value: "abacus/claude-sonnet-5",
      label: "Sonnet 5",
      onChange: () => {},
      groups: [],
    },
  };
  // An outgrown chat on a pinned model, as the agent ends it by credits.
  const tooLong = (way: Array<Record<string, unknown>>) =>
    failed({
      message:
        "This conversation is too long for the model (413). Start a new chat, or switch to a model with a larger context.",
      cause: "context_too_long",
      actions: [{ type: "new-chat" }, ...way],
    });

  it("with Abacus credits left, every card's switch is RouteLLM - Open, the picker beside it", async () => {
    const relay = tooLong([
      { type: "switch-to-abacus" },
      { type: "switch-model" },
    ]);
    current = await renderRelay(
      relay,
      "session",
      chatComposer,
      {},
      host("free")
    );
    const card = (await screen.findByText(/too long for the model/)).closest(
      '[data-slot="error-card"]'
    ) as HTMLElement;
    expect(within(card).getByRole("button", { name: "New chat" })).toBeTruthy();
    expect(
      within(card).getByRole("button", { name: "Pick another model" })
    ).toBeTruthy();
    expect(
      within(card).queryByRole("button", { name: "Switch model" })
    ).toBeNull();
    fireEvent.click(
      within(card).getByRole("button", { name: "Switch to RouteLLM - Open" })
    );
    await waitFor(() => expect(relay.stats.send).toHaveLength(1));
    expect(relay.stats.send[0]!.forwardedProps).toMatchObject({
      model: OPENLLM_ID,
    });
  });

  it("with the credits used up, no switch: the card carries the plan's whole offer, whatever failed", async () => {
    current = await renderRelay(
      tooLong([{ type: "plan-offer" }]),
      "session",
      chatComposer,
      {},
      host("free")
    );
    const card = (await screen.findByText(/too long for the model/)).closest(
      '[data-slot="error-card"]'
    ) as HTMLElement;
    expect(within(card).getByRole("button", { name: "New chat" })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /Switch/ })).toBeNull();
    expect(await within(card).findByText("Basic gets you:")).toBeTruthy();
    expect(within(card).getByText("Image and video generation")).toBeTruthy();
    expect(
      within(card).getByRole("button", { name: "See plans" })
    ).toBeTruthy();
    fireEvent.click(
      within(card).getByRole("button", { name: "Upgrade · $7 first month" })
    );
    expect(upgradeDialogStore.state.request).toMatchObject({ kind: "credits" });
    closeUpgradeDialog();
  });

  it("signed out or already on RouteLLM - Open, the card keeps its bare switch", async () => {
    current = await renderRelay(
      tooLong([{ type: "switch-model" }]),
      "session",
      chatComposer,
      {},
      host("free")
    );
    const card = (await screen.findByText(/too long for the model/)).closest(
      '[data-slot="error-card"]'
    ) as HTMLElement;
    expect(
      within(card).getByRole("button", { name: "Switch model" })
    ).toBeTruthy();
    expect(within(card).queryByText("Switch to RouteLLM - Open")).toBeNull();
  });

  it("names a model by its own id, never recased", async () => {
    current = await renderRelay(
      failed({
        message: "The model returned an empty reply.",
        cause: "empty",
        actions: [
          {
            type: "own-key-unavailable",
            provider: "fake",
            cause: "no_reply",
            model: "fake/fake-1",
            label: "fake-1",
          },
        ],
      }),
      "session",
      {},
      {},
      host("free")
    );
    expect(
      await screen.findByText("fake-1 on Fake sent no reply")
    ).toBeTruthy();
  });

  it("a message moved to RouteLLM - Open says so in one line, in the app's words", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r1"),
      ...b.text("u1", "user", "fix the bug"),
      b.custom("agent.notification", {
        message:
          "Kimi K3 on NVIDIA isn't available, so this ran on RouteLLM - Open.",
        severity: "info",
        actions: [
          {
            type: "moved-to-abacus",
            provider: "nvidia",
            model: "nvidia/moonshotai/kimi-k3",
            label: "Kimi K3",
            free: true,
          },
        ],
      }),
    ]);
    current = await renderRelay(relay, "session", {}, {}, host("free"));
    expect(
      await screen.findByText(
        "Kimi K3 on NVIDIA NIM isn't available, so I switched this chat to RouteLLM - Open."
      )
    ).toBeTruthy();
  });

  const unavailable = (cause: string, out = false) =>
    failed({
      message: "Sonnet 5 isn't available anymore. Your message is kept.",
      cause: cause === "plan" ? "not_in_plan" : "model_unavailable",
      actions: [
        {
          type: "model-unavailable",
          cause,
          model: "abacus/s5",
          label: "Sonnet 5",
        },
        out
          ? { type: "upgrade-abacus", cause: "exhausted" }
          : { type: "switch-to-abacus" },
      ],
    });
  const withCredits = {
    billingPlan: async () => ({
      ...BILLING,
      current: { ...BILLING.current, creditsRemaining: 1500 },
    }),
  };

  it("an unavailable model with credits left offers RouteLLM - Open, re-sending the kept message", async () => {
    const relay = unavailable("retired");
    current = await renderRelay(
      relay,
      "session",
      {},
      {},
      host("free", withCredits)
    );
    const title = await screen.findByText("Sonnet 5 isn't available anymore");
    const card = title.closest('[data-slot="credits-card"]') as HTMLElement;
    expect(
      within(card).getByText(
        "It was removed from the models you can use. Your message is kept."
      )
    ).toBeTruthy();
    expect(
      await within(card).findByText("1,500 Abacus credits left")
    ).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /Upgrade/ })).toBeNull();
    // Nothing moved on its own.
    expect(relay.stats.send).toHaveLength(0);
    fireEvent.click(
      within(card).getByRole("button", { name: "Switch to RouteLLM - Open" })
    );
    await waitFor(() => expect(relay.stats.send).toHaveLength(1));
    expect(relay.stats.send[0]!.forwardedProps).toMatchObject({
      model: OPENLLM_ID,
    });
  });

  it("an unavailable model with the credits used up offers the plan, priced from billing_plan", async () => {
    current = await renderRelay(
      unavailable("retired", true),
      "session",
      {},
      {},
      host("free")
    );
    const title = await screen.findByText("Sonnet 5 isn't available anymore");
    const card = title.closest('[data-slot="credits-card"]') as HTMLElement;
    expect(
      within(card).getByText("You've also used your free Abacus credits.")
    ).toBeTruthy();
    expect(
      await within(card).findByRole("button", {
        name: "Upgrade · $7 first month",
      })
    ).toBeTruthy();
    expect(
      within(card).getByRole("button", { name: "See plans" })
    ).toBeTruthy();
    expect(within(card).getByText("0 Abacus credits left")).toBeTruthy();
    expect(within(card).queryByText("Switch to RouteLLM - Open")).toBeNull();
  });

  it("Basic with an unavailable model and its credits used up gets the free plan's card for Pro, no Top up", async () => {
    current = await renderRelay(
      unavailable("retired", true),
      "session",
      {},
      {},
      host("basic", {
        canTopUpCredits: async () => true,
        billingPlan: async () => BASIC_BILLING,
      })
    );
    const title = await screen.findByText("Sonnet 5 isn't available anymore");
    const card = title.closest('[data-slot="credits-card"]') as HTMLElement;
    expect(
      await within(card).findByRole("button", { name: "Upgrade · $20/month" })
    ).toBeTruthy();
    expect(
      within(card).getByText("You've also used this month's Abacus credits.")
    ).toBeTruthy();
    expect(within(card).getByText("Pro gets you:")).toBeTruthy();
    expect(
      within(card).getByRole("button", { name: "See plans" })
    ).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Top up" })).toBeNull();
    fireEvent.click(
      within(card).getByRole("button", { name: "Upgrade · $20/month" })
    );
    expect(upgradeDialogStore.state.request).toMatchObject({
      kind: "credits",
    });
    closeUpgradeDialog();
  });

  it("a model the plan does not include leads with RouteLLM - Open, the plan's whole offer beside it", async () => {
    current = await renderRelay(
      unavailable("plan"),
      "session",
      {},
      {},
      host("free", withCredits)
    );
    const title = await screen.findByText(
      "Sonnet 5 isn't included in your plan"
    );
    const card = title.closest('[data-slot="credits-card"]') as HTMLElement;
    expect(
      await within(card).findByText(
        "Keep going on a free model now, or upgrade to Basic to use it."
      )
    ).toBeTruthy();
    expect(
      within(card).getByRole("button", { name: "Switch to RouteLLM - Open" })
    ).toBeTruthy();
    // The plan's whole offer beside it, priced, never a bare link.
    expect(within(card).getByText("Basic gets you:")).toBeTruthy();
    expect(within(card).getByText("Image and video generation")).toBeTruthy();
    expect(
      within(card).getByRole("button", { name: "Upgrade · $7 first month" })
    ).toBeTruthy();
    expect(
      within(card).getByRole("button", { name: "See plans" })
    ).toBeTruthy();
  });

  it("a rejected own key with the Abacus credits used up shows the upgrade card, with the key fix beside it", async () => {
    current = await renderRelay(
      failed({
        message: "Your OpenAI key was rejected — it's invalid or expired.",
        cause: "key_invalid",
        actions: [
          { type: "fix-key", provider: "openai" },
          { type: "upgrade-abacus", cause: "exhausted" },
        ],
      }),
      "session",
      {},
      {},
      host("free")
    );
    await screen.findByText(
      "“fix the bug” is paused: your free credits are used up"
    );
    expect(
      await screen.findByRole("button", { name: "Upgrade · $7 first month" })
    ).toBeTruthy();
    expect(screen.getByText("Check the key")).toBeTruthy();
    expect(screen.queryByText(/Switch to Abacus/)).toBeNull();
  });

  it("a paid account out of credits with a rejected key is offered a top-up", async () => {
    current = await renderRelay(
      failed({
        message: "Your OpenAI key was rejected — it's invalid or expired.",
        cause: "key_invalid",
        actions: [
          { type: "fix-key", provider: "openai" },
          { type: "upgrade-abacus", cause: "exhausted" },
        ],
      }),
      "session",
      {},
      {},
      host("basic", { canTopUpCredits: async () => true })
    );
    expect(await screen.findByRole("button", { name: "Top up" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Upgrade to/ })).toBeNull();
  });

  it("labels a free-lane reply with its provider while the wall stands, and drops it once credits are back", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r1"),
      ...b.text("u1", "user", "go on"),
      ...b.text("a1", "assistant", "done"),
      b.runFinished("r1", "success", {
        metadata: {
          abacus: {
            turnUsage: { lane: "free", provider: "openrouter", model: "x" },
          },
        },
      }),
    ]);
    current = await renderRelay(relay, "session");
    await (
      current as unknown as { db: { updatePrefs(p: object): Promise<void> } }
    ).db.updatePrefs({
      creditsExhaustedAt: Date.now(),
    });
    await screen.findByText("Free model · OpenRouter");
    expect(screen.getByText("Upgrade for top models")).toBeTruthy();
    await (
      current as unknown as { db: { updatePrefs(p: object): Promise<void> } }
    ).db.updatePrefs({
      creditsExhaustedAt: null,
    });
    await waitFor(() =>
      expect(screen.queryByText("Free model · OpenRouter")).toBeNull()
    );
  });

  it("labels a free-lane reply in a bot chat too, where no run marker is drawn", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r1"),
      ...b.text("u1", "user", "go on"),
      ...b.text("a1", "assistant", "done"),
      b.runFinished("r1", "success", {
        metadata: {
          abacus: { turnUsage: { lane: "free", provider: "gemini" } },
        },
      }),
    ]);
    current = await renderRelay(relay, "bot");
    await (
      current as unknown as { db: { updatePrefs(p: object): Promise<void> } }
    ).db.updatePrefs({ creditsExhaustedAt: Date.now() });
    await screen.findByText("Free model · Google Gemini");
  });
});

describe("the turn's credits", () => {
  const ACCOUNT = {
    user_id: "u1",
    organization_id: "o1",
    name: null,
    email: null,
    picture: null,
    organization: null,
    org_user_count: null,
    plan: "Free",
    subscription_tier: "free",
    credits_used: 618,
    credits_granted: 2000,
  };
  const turn = (credits: unknown) => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r1", { timestamp: 1_000 }),
      ...b.text("u1", "user", "go"),
      ...b.text("a1", "assistant", "done"),
      b.runFinished("r1", "success", {
        timestamp: 13_000,
        ...(credits !== undefined && {
          metadata: { abacus: { turnUsage: { credits } } },
        }),
      }),
    ]);
    return relay;
  };
  const served = (
    account: Record<string, unknown> | null,
    funnel = vi.fn()
  ) => {
    const os = implement(contract);
    return {
      account: {
        abacus: os.account.abacus.handler(() => account as never),
        payment: os.account.payment.handler(() => null),
      },
      system: {
        funnelStep: os.system.funnelStep.handler(({ input }) => {
          funnel(input);
        }),
      },
    };
  };
  afterEach(() => closeUpgradeDialog());

  it.each([
    [
      "a free turn, with what is left",
      ACCOUNT,
      18.4,
      "18 credits · 1,382 left",
    ],
    ["a tiny turn", ACCOUNT, 0.3, "<1 credit · 1,382 left"],
    [
      "a paid turn",
      { ...ACCOUNT, plan: "Basic", subscription_tier: "basic" },
      1240.6,
      "1,241 credits · 1,382 left",
    ],
  ])("%s", async (_name, account, credits, label) => {
    current = await renderRelay(
      turn(credits),
      "session",
      {},
      {},
      undefined,
      served(account)
    );
    const line = await screen.findByRole("button", {
      name: `${label}. See your plan and credits`,
    });
    expect(line.textContent).toBe(label);
  });

  it.each([
    ["an own-key turn (no Abacus request)", ACCOUNT, undefined],
    ["a turn whose charge is unknown", ACCOUNT, null],
    ["a free-model turn", ACCOUNT, 0],
    [
      "an account with no plan to offer",
      { ...ACCOUNT, plan: null, subscription_tier: null },
      18,
    ],
  ])("shows nothing for %s", async (_name, account, credits) => {
    current = await renderRelay(
      turn(credits),
      "session",
      {},
      {},
      undefined,
      served(account)
    );
    await screen.findByText(/^Done in 12/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector('[data-slot="turn-credits"]')).toBeNull();
  });

  it("opens the plan dialog and records the click", async () => {
    const funnel = vi.fn();
    current = await renderRelay(
      turn(18),
      "session",
      {},
      {},
      undefined,
      served(ACCOUNT, funnel)
    );
    fireEvent.click(await screen.findByRole("button", { name: /^18 credits/ }));
    expect(upgradeDialogStore.state.request).toMatchObject({
      kind: "balance",
      src: "turn_credits",
    });
    await waitFor(() =>
      expect(funnel).toHaveBeenCalledWith({
        step: "turn_credits_clicked",
        detail: "free",
      })
    );
  });
});
