/**
 * The kit rendered over replayed scenarios (spec 02 §5, §11): R2-T11 (parts
 * through the exported configurations, incl. migrated history), R2-T12
 * (open tool and sub-agent names), R2-T15 (status components), R2-T22
 * (two pending permissions, the second answered first through the rendered
 * controls, both skins).
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageFeedback } from "#renderer/components/message-feedback";

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
    // A sub-agent's own error is for the log: its card says it failed.
    expect(within(rows[2] as HTMLElement).getByText("Failed")).toBeTruthy();
    expect(screen.queryByText("Stopped at its limit")).toBeNull();
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
    // No cause the app has copy for: its generic line, never the provider's.
    expect(
      within(card).getByText(/The model couldn.t finish this/)
    ).toBeTruthy();
    expect(within(card).queryByText(/429|rate limited/)).toBeNull();
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

it.each([
  ["a link", "a"],
  ["a code block", "pre"],
])(
  "a tall user message folds once; a press or the text's own focus leaves it folded, keyboard focus on %s below the fold opens it",
  async (_label, below) => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r1"),
      ...b.text(
        "u1",
        "user",
        `${"A long paragraph of the user's own words. ".repeat(80)}\n\n\`\`\`text\n${"log line\n".repeat(40)}\`\`\`\n\nSee [the spec](https://example.test/spec).`
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
            : this.tagName === "A" || this.tagName === "PRE"
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
      // A press on what reaches below the fold (a drag-select starting there) focuses it: still folded.
      const target = fold.querySelector<HTMLElement>(below)!;
      fireEvent.pointerDown(target);
      target.focus();
      fireEvent.pointerUp(target);
      expect(fold.hasAttribute("data-folded")).toBe(true);
      target.blur();
      // Keyboard focus landing there opens it.
      target.focus();
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
        delete (HTMLElement.prototype as { scrollHeight?: number })
          .scrollHeight;
    }
  }
);

it("a long thumbs note in a chat is saved where the chat's composer saves a paste", async () => {
  const relay = new FakeRelay();
  relay.emitAll([
    ...b.sessionReady(),
    b.runStarted("r1"),
    ...b.text("u1", "user", "build the header"),
    ...b.text("a1", "assistant", "Done: the header is in index.html."),
    b.runFinished("r1"),
  ]);
  const send = vi.fn(
    async (_rating: string, _comment?: string, _file?: string) => ({
      ok: true as const,
    })
  );
  const rendered = await renderRelay(
    relay,
    "session",
    { attachmentsBase: "/repo" },
    {
      slots: {
        decorateMessage: (message) =>
          message.role === "assistant"
            ? { after: <MessageFeedback send={send} reader={{}} /> }
            : null,
      },
    }
  );
  cleanups.push(() => rendered.cleanup());
  const savePasted = vi
    .spyOn(rendered.runtime.host, "savePasted")
    .mockImplementation(async (base, files) =>
      files.map((file) => `${base}/.abacusai-bot/temp/${file.name}`)
    );
  fireEvent.click(await screen.findByRole("button", { name: "Bad response" }));
  const box = await screen.findByRole("textbox", { name: "Tell us more" });
  const note = "a note the user pasted ".repeat(5_000);
  fireEvent.change(box, { target: { value: note } });
  expect(
    await screen.findByText(
      "Long text goes in as a pasted-text file, read in full."
    )
  ).toBeTruthy();
  // The box's own Send, not the composer's.
  fireEvent.click(
    within(box.closest("form")!).getByRole("button", { name: "Send" })
  );
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(savePasted).toHaveBeenCalledTimes(1);
  expect(savePasted.mock.calls[0]![0]).toBe("/repo");
  const [, start, file] = send.mock.calls[1]!;
  expect(start).toBe(note.trim().slice(0, 100_000));
  expect(file).toMatch(
    /^\/repo\/\.abacusai-bot\/temp\/pasted-text-note-[0-9a-f]{16}\.txt$/
  );
});
