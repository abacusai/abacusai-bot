/**
 * The kit rendered over replayed scenarios (spec 02 §5, §11): R2-T11 (parts
 * through the exported configurations, incl. migrated history), R2-T12
 * (open tool and sub-agent names), R2-T15 (status components), R2-T22
 * (two pending permissions, the second answered first through the rendered
 * controls, both skins).
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { renderRelay, renderScenario } from "../testing";

let current: Awaited<ReturnType<typeof renderScenario>> | null = null;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await current?.cleanup();
  current = null;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Tool runs start closed; open every one that is mounted. */
const openRuns = () => {
  for (const trigger of document.querySelectorAll(
    '[data-slot="tool-group"] > button[aria-expanded="false"]'
  ))
    fireEvent.click(trigger);
};

describe("ChatView over scenarios", () => {
  it("renders a golden replay in the bot skin", async () => {
    current = await renderScenario("bot-golden-plain");
    expect(await screen.findByText("Hello there.")).toBeTruthy();
    expect(screen.getByText("hi")).toBeTruthy();
    expect(document.querySelector('[data-slot="run-marker"]')).toBeNull();
    expect(screen.getByRole("log")).toBeTruthy();
  });

  it("renders the running session: step rows, busy line, queue row, stop", async () => {
    const warn = vi.spyOn(console, "warn");
    current = await renderScenario("session-running");
    await screen.findByText(/The restore takes all of its width/);
    openRuns();
    await waitFor(() =>
      expect(document.querySelectorAll("[data-tool]").length).toBeGreaterThan(0)
    );
    const rows = [...document.querySelectorAll("[data-tool]")];
    expect(rows.map((row) => row.getAttribute("data-tool"))).toEqual([
      "read",
      "grep",
      "edit",
      "bash",
    ]);
    const status = (name: string) =>
      rows
        .find((row) => row.getAttribute("data-tool") === name)!
        .querySelector("[data-status]")!
        .getAttribute("data-status");
    expect(status("read")).toBe("done");
    expect(status("bash")).toBe("running");
    expect(
      within(rows[0] as HTMLElement).getByText("lines 168 to 268")
    ).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("4 matches")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("+24")).toBeTruthy();
    expect(document.querySelector('[data-slot="busy-line"]')).toBeTruthy();
    expect(
      screen.getByText("Also add a test for the full-width case")
    ).toBeTruthy();
    expect(screen.getByText("Sends at the next step")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByRole("log").getAttribute("aria-busy")).toBe("true");
    expect(
      warn.mock.calls.filter((call) =>
        String(call[0]).includes("tanstack-ai-ui")
      )
    ).toEqual([]);
  });

  it("R2-T12: open tool names and sub-agent kinds resolve to the generic widgets", async () => {
    const warn = vi.spyOn(console, "warn");
    current = await renderScenario("session-subagents");
    await screen.findByText("Audit packages/agent");
    const rows = document.querySelectorAll('[data-slot="subagent-row"]');
    expect([...rows].map((row) => row.getAttribute("data-status"))).toEqual([
      "finished",
      "running",
      "error",
    ]);
    expect(screen.getByText("Stopped at its limit")).toBeTruthy();
    // A finished sub-agent's report shows under its collapsed card.
    expect(
      within(rows[0] as HTMLElement).getByText("No issues.", {
        selector: '[data-slot="subagent-report"] *',
      })
    ).toBeTruthy();
    expect(rows[1]!.querySelector('[data-slot="subagent-report"]')).toBeNull();
    expect(
      warn.mock.calls.filter((call) => String(call[0]).includes("Missing"))
    ).toEqual([]);
  });

  it("R2-T15: the rate-limit error card with its actions", async () => {
    current = await renderScenario("session-failed-ratelimit", {
      composer: {
        model: {
          value: "claude",
          label: "Claude",
          onChange: vi.fn(),
          groups: [],
        },
      },
    });
    const card = await screen.findByRole("group", { name: "Error" });
    expect(
      within(card).getByText("Claude is rate limited right now")
    ).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(
      within(card).getByRole("button", { name: /Continue on Abacus\.AI/ })
    ).toBeTruthy();
  });

  it("R2-T11: migrated history renders every segment kind without throwing", async () => {
    current = await renderScenario("session-migrated");
    await waitFor(() => expect(screen.getByRole("log")).toBeTruthy());
    const items = document.querySelectorAll(
      '[data-slot="message-scroller-item"]'
    );
    expect(items.length).toBeGreaterThan(10);
  });

  it("R2-T22 sessions: the tray answers the second request first through chips", async () => {
    current = await renderScenario("perm-two-pending");
    const chips = await screen.findAllByRole("button", { pressed: false });
    const second = chips.find((chip) => chip.textContent?.startsWith("Edit"))!;
    fireEvent.click(second);
    expect(second.getAttribute("aria-pressed")).toBe("true");
    const card = await screen.findByRole("group", {
      name: "Edit workspace-view.tsx?",
    });
    fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
    const respond = current.fixture.relay.stats.respond;
    await waitFor(() => expect(respond).toHaveLength(1));
    expect((respond[0]!.lineage as { permissionId: string }).permissionId).toBe(
      "p2"
    );
  });

  it("R2-T22 bots: the inline card at the tool's position answers", async () => {
    current = await renderScenario("bot-approval-inline");
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-slot="permission-card"]')
      ).toHaveLength(1)
    );
    const card = await screen.findByRole("group", { name: /Use gmail_send/ });
    fireEvent.click(within(card).getByRole("button", { name: "Allow" }));
    await waitFor(() =>
      expect(current!.fixture.relay.stats.respond).toHaveLength(1)
    );
    // The list above the composer does not repeat an inline card.
    expect(document.querySelector('[data-slot="permission-list"]')).toBeNull();
  });
});

it("a tall user message folds once; a click or the text's own focus leaves it folded, Tab to a link below the fold opens it", async () => {
  const relay = new FakeRelay();
  relay.emitAll([
    ...b.sessionReady(),
    b.runStarted("r1"),
    ...b.text(
      "u1",
      "user",
      `${"A long paragraph of the user's own words. ".repeat(80)}\n\nSee [the spec](https://example.test/spec).`
    ),
    b.runFinished("r1"),
  ]);
  const height = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight"
  );
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const bottom =
        this.dataset.slot === "user-text"
          ? 320
          : this.tagName === "A"
            ? 900
            : 2000;
      return {
        top: 0,
        bottom,
        left: 0,
        right: 600,
        width: 600,
        height: bottom,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
  const clientHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight"
  );
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.slot === "user-text" ? 320 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.slot === "user-text" ? 2000 : 0;
    },
  });
  try {
    const rendered = await renderRelay(relay, "session");
    cleanups.push(() => rendered.cleanup());
    const fold = await waitFor(() => {
      const node = document.querySelector('[data-slot="user-text"]');
      expect(node?.hasAttribute("data-folded")).toBe(true);
      return node as HTMLElement;
    });
    // A click (and the selectable text's own focus) is not a reason to open.
    const text = fold.querySelector<HTMLElement>("[data-message-text]")!;
    fireEvent.mouseDown(text);
    text.focus();
    fireEvent.click(text);
    expect(fold.hasAttribute("data-folded")).toBe(true);
    // Tab lands on a link hidden below the fold: it opens.
    fold.querySelector<HTMLElement>("a")!.focus();
    await waitFor(() => expect(fold.hasAttribute("data-folded")).toBe(false));
    expect(
      document.querySelector('[data-slot="user-text-more"]')?.textContent
    ).toBe("Show less");
  } finally {
    rect.mockRestore();
    if (clientHeight)
      Object.defineProperty(
        HTMLElement.prototype,
        "clientHeight",
        clientHeight
      );
    if (height)
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", height);
    else
      delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  }
});
