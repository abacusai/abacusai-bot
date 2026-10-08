import { ORPCError } from "@orpc/client";
/**
 * R2-T25 (spec 02 §8): geometry per skin (pill ↔ box), Stop replacing Send
 * while busy, the mode chip's labels, descriptions and values with the
 * optimistic revert, the pre-start mode sent once as `forwardedProps.mode`,
 * pasted files through `savePasted`, the `/` menu inserting a skill, a busy
 * submit going to the host queue, `ArrowUp` editing the last queued item.
 */
import {
  act,
  fireEvent,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearDraft,
  updateDraft,
  draftRevision,
  draftStore,
} from "#renderer/lib/continuity/composer-drafts";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { renderRelay, renderScenario, renderWithDb } from "../testing";
import { ModeChip, ModelChip } from "./chips";
import { SURFACE_RADIUS, useComposerExpanded } from "./composer";

const sent = vi.hoisted(() => vi.fn());
vi.mock("#renderer/lib/document-sound", () => ({
  documentSoundPlayer: () => ({ play: sent }),
}));

let current: { cleanup(): Promise<void> } | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await current?.cleanup();
  current = null;
  clearDraft("t-1");
});

const composer = () =>
  document.querySelector('[data-slot="composer"]') as HTMLElement;
const field = () => within(composer()).getByRole("textbox");

describe("R2-T25 composer", () => {
  it("does not materialize the closed model catalog, then searches and selects it on open", async () => {
    const reads = vi.fn(() => "Catalog model");
    const onChange = vi.fn();
    current = await renderWithDb(
      <ModelChip
        binding={{
          value: null,
          label: "Choose model",
          onChange,
          groups: [
            {
              id: "provider",
              label: "Provider",
              items: [
                {
                  id: "model-id",
                  get label() {
                    return reads();
                  },
                },
              ],
            },
          ],
        }}
      />
    );
    expect(reads).not.toHaveBeenCalled();
    // The chip is the picker's trigger (a Base UI combobox button).
    fireEvent.click(screen.getByRole("combobox", { name: /Choose model/ }));
    await screen.findByRole("option", { name: "Catalog model" });
    expect(reads).toHaveBeenCalled();
    // The panel (Pickers): a search field over the grouped rows.
    const search = screen.getByRole("combobox", { name: "Models" });
    fireEvent.change(search, { target: { value: "absent" } });
    expect(screen.queryByRole("option", { name: "Catalog model" })).toBeNull();
    expect(screen.getByText("No models match")).toBeTruthy();
    fireEvent.change(search, { target: { value: "Catalog" } });
    fireEvent.click(
      await screen.findByRole("option", { name: "Catalog model" })
    );
    expect(onChange).toHaveBeenCalledWith("model-id");
  });

  it("exports focus-or-draft expansion and clears focus on unmount", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    const rendered = await renderRelay(relay, "bot");
    current = rendered;
    await waitFor(() => expect(composer()).toBeTruthy());
    const probe = renderHook(() => useComposerExpanded("t-1"));
    expect(probe.result.current).toBe(false);
    fireEvent.focus(field());
    expect(probe.result.current).toBe(true);
    fireEvent.blur(field());
    expect(probe.result.current).toBe(false);
    fireEvent.change(field(), { target: { value: "draft" } });
    expect(probe.result.current).toBe(true);
    act(() => clearDraft("t-1"));
    expect(probe.result.current).toBe(false);
    probe.unmount();
  });

  it("bot: a pill at rest, a box with text; Send tinted only with text", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    current = await renderRelay(relay, "bot");
    await waitFor(() => expect(composer()).toBeTruthy());
    expect(composer().hasAttribute("data-expanded")).toBe(false);
    expect(
      within(composer())
        .getByRole("button", { name: "Send" })
        .hasAttribute("disabled")
    ).toBe(true);
    fireEvent.change(field(), { target: { value: "hello" } });
    expect(composer().hasAttribute("data-expanded")).toBe(true);
    expect(
      within(composer())
        .getByRole("button", { name: "Send" })
        .hasAttribute("disabled")
    ).toBe(false);
  });

  it("morphs only the surface: its children keep their size and its radius is a style", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    current = await renderRelay(relay, "bot");
    await waitFor(() => expect(composer()).toBeTruthy());
    const surface = () =>
      document.querySelector<HTMLElement>('[data-slot="composer-surface"]')!;
    const check = (radius: number) => {
      // Only the surface carries `layout`; motion's projection scales it,
      // and the radius lives in `style` so the projection corrects it
      // mid-morph (a class would stretch with the surface).
      expect(surface().dataset.layout).toBe("layout");
      expect(surface().dataset.radius).toBe(String(radius));
      // The live value is motion's tween of that target, mid-morph.
      expect(surface().style.borderRadius).toMatch(/^\d+(\.\d+)?px$/);
      expect(surface().className).not.toMatch(/rounded/);
      // Every direct child is a `layout="position"` child: it slides, it
      // never stretches (icons, chips, buttons, the text area).
      const children = [...surface().children] as HTMLElement[];
      expect(children.length).toBeGreaterThan(1);
      for (const child of children)
        expect(child.dataset.layout, child.outerHTML).toBe("position");
    };
    check(SURFACE_RADIUS.pill);
    fireEvent.change(field(), { target: { value: "hello" } });
    expect(composer().hasAttribute("data-expanded")).toBe(true);
    check(SURFACE_RADIUS.bot);
    expect(field().dataset.layout).toBe("position");
  });

  it("session: the box holds the text area and the toolbar; the context bar hangs under it", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    current = await renderRelay(
      relay,
      "session",
      {},
      { slots: { composerContext: <span>abacusai-bot · main</span> } }
    );
    await waitFor(() =>
      expect(composer().hasAttribute("data-expanded")).toBe(true)
    );
    const surface = document.querySelector<HTMLElement>(
      '[data-slot="composer-surface"]'
    )!;
    // ComposerStates "Session, resting": a 100 px box, 8 px under the
    // toolbar row, the text area taking the spare height (no void below
    // the toolbar), corners 20 px.
    expect(surface.className).toContain("min-h-[100px]");
    expect(surface.className).toContain("pb-2");
    expect(surface.className).toContain("[&>textarea]:flex-1");
    expect(surface.dataset.radius).toBe(String(SURFACE_RADIUS.session));
    const toolbar = within(surface).getByRole("button", {
      name: "Send",
    }).parentElement!;
    expect(surface.lastElementChild).toBe(toolbar);
    // The context bar: its own 48 px strip inset 12 px, bottom corners
    // 14 px, tucked 16 px under the box with 16 px of top padding.
    const context = document.querySelector<HTMLElement>(
      '[data-slot="composer-context"]'
    )!;
    expect(surface.nextElementSibling).toBe(context);
    expect(within(context).getByText("abacusai-bot · main")).toBeTruthy();
    for (const cls of ["mx-3", "-mt-4", "min-h-12", "pt-4", "rounded-b-[14px]"])
      expect(context.className.split(" ")).toContain(cls);
  });

  it("session: two rows at rest with the mode chip; Enter sends; Stop while busy; busy submit enqueues", async () => {
    let started: (() => void) | null = null;
    const relay = new FakeRelay({
      onSend: (input, r) => {
        started = () =>
          r.emitAll([
            b.runStarted(input.runId),
            ...b.text(input.messages[0]!.id, "user", "hi"),
          ]);
        return { runId: input.runId, status: "started" };
      },
    });
    relay.emitAll(b.sessionReady());
    const rendered = await renderRelay(relay, "session");
    current = rendered;
    await waitFor(() =>
      expect(composer().hasAttribute("data-expanded")).toBe(true)
    );
    expect(
      within(composer()).getByRole("button", { name: /Supervised/ })
    ).toBeTruthy();
    fireEvent.change(field(), { target: { value: "hi" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(relay.stats.send).toHaveLength(1));
    expect(relay.stats.send[0]!.forwardedProps).toBeUndefined();
    await waitFor(() =>
      expect(sent).toHaveBeenCalledExactlyOnceWith("sent", {
        threadId: "t-1",
        botId: undefined,
      })
    );
    act(() => started!());
    await screen.findByRole("button", { name: "Stop" });
    fireEvent.change(field(), { target: { value: "and this" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() =>
      expect(relay.stats.queue.at(-1)).toMatchObject({
        command: "enqueue",
        input: { message: "and this" },
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(relay.stats.cancel).toHaveLength(1));
  });

  it("shift+Enter is a newline and IME composition never submits", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    current = await renderRelay(relay, "session");
    await waitFor(() => expect(composer()).toBeTruthy());
    fireEvent.change(field(), { target: { value: "x" } });
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(relay.stats.send).toHaveLength(0);
    expect(sent).not.toHaveBeenCalled();
  });

  it("pre-start: the draft's mode goes out once as forwardedProps.mode", async () => {
    const relay = new FakeRelay();
    current = await renderRelay(relay, "session", { preStart: true });
    await waitFor(() => expect(composer()).toBeTruthy());
    act(() =>
      updateDraft("t-1", (draft) => ({ ...draft, mode: "PLAN" as never }))
    );
    fireEvent.change(field(), { target: { value: "plan it" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(relay.stats.send).toHaveLength(1));
    expect(relay.stats.send[0]!.forwardedProps).toEqual({ mode: "PLAN" });
  });

  it("keeps the full composer and its trigger mounted while the mode menu is open", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    current = await renderRelay(relay, "session");
    const trigger = await screen.findByRole("button", { name: /Supervised/ });
    fireEvent.click(trigger);
    expect(await screen.findByRole("listbox")).toBeTruthy();
    expect(composer().hasAttribute("data-expanded")).toBe(true);
    expect(trigger.isConnected).toBe(true);
    // Escape closes the list and leaves the composer expanded (focus stays).
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("the model picker: a provider rail with marks, search on top, dense rows with the chosen one checked, keyboard navigable", async () => {
    const onChange = vi.fn();
    const connect = vi.fn();
    const useLocal = vi.fn();
    const configure = vi.fn();
    current = await renderWithDb(
      <ModelChip
        onUseLocalModel={useLocal}
        binding={{
          value: "route-llm",
          onConfigureProviders: configure,
          label: "RouteLLM",
          onChange,
          groups: [
            {
              id: "favourites",
              label: "Favourites",
              items: [
                {
                  id: "route-llm",
                  label: "RouteLLM",
                  description: "Abacus.AI",
                },
              ],
            },
            {
              id: "abacus",
              label: "Abacus.AI",
              items: [
                { id: "route-llm", label: "RouteLLM" },
                { id: "route-llm-open", label: "RouteLLM Open" },
              ],
            },
            {
              id: "openrouter",
              label: "OpenRouter",
              items: [],
              connect: { label: "Connect OpenRouter", onSelect: connect },
            },
          ],
        }}
      />
    );
    // The chip: the provider's mark, the model's name, its provider muted.
    const chip = screen.getByRole("combobox", { name: /RouteLLM/ });
    expect(chip.textContent).toContain("Abacus.AI");
    expect(
      chip.querySelector<HTMLElement>('[data-slot="connector-mark"]')?.dataset
        .mark
    ).toBe("abacus");
    fireEvent.click(chip);
    const panel = await screen.findByRole("listbox");
    const content = panel.closest(
      '[data-slot="chat-model-panel"]'
    ) as HTMLElement;
    expect(content.className).toContain("w-[min(360px");
    // The rail: favourites, each provider with its mark, this machine.
    const rail = [
      ...content.querySelectorAll<HTMLElement>(
        '[data-slot="chat-model-rail-item"]'
      ),
    ];
    expect(rail.map((item) => item.getAttribute("aria-label"))).toEqual([
      "Favourites",
      "Abacus.AI",
      "OpenRouter",
      "On this machine",
    ]);
    // It opens on the chosen model's provider, that row checked, the
    // local-model row at the foot of every view.
    expect(rail[1]!.getAttribute("aria-selected")).toBe("true");
    expect(
      [...content.querySelectorAll('[data-slot="combobox-label"]')].map(
        (heading) => heading.textContent
      )
    ).toEqual(["Abacus.AI"]);
    expect(
      within(panel)
        .getAllByRole("option")
        .filter((option) => option.dataset.checked === "true")
        .map((option) => option.textContent)
    ).toEqual(["RouteLLM"]);
    expect(within(panel).getByText("Use a local model")).toBeTruthy();
    // Keyboard from the search field: the arrow keys move, Enter picks.
    const search = screen.getByRole("combobox", { name: "Models" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith("route-llm-open")
    );
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    // A provider that is not connected: the card with its connect action.
    fireEvent.click(chip);
    await screen.findByRole("listbox");
    fireEvent.click(screen.getByRole("tab", { name: "OpenRouter" }));
    expect(screen.getByText("OpenRouter is not connected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect OpenRouter" }));
    expect(connect).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    fireEvent.click(chip);
    await screen.findByRole("listbox");
    fireEvent.click(
      screen.getByRole("button", { name: "Configure providers" })
    );
    expect(configure).toHaveBeenCalledOnce();
  });

  it("the mode menu: five modes with descriptions; choosing sets the mode, a silent agent reverts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const setMode = vi.fn(() => Promise.resolve());
    const onRevert = vi.fn();
    const rendered = await renderWithDb(
      <ModeChip
        value={"DEFAULT" as never}
        draft={undefined}
        live
        onDraft={() => {}}
        setMode={setMode}
        onRevert={onRevert}
        defaultOpen
      />
    );
    current = rendered;
    for (const [label, description] of [
      ["Auto", "Sandboxed, no prompts"],
      ["Auto-accept edits", "Change files, ask before commands"],
      ["Plan", "Read and propose, change nothing"],
      ["Full access", "No approvals"],
    ]) {
      expect(await screen.findByText(label!)).toBeTruthy();
      expect(screen.getByText(description!)).toBeTruthy();
    }
    for (const option of screen.getAllByRole("option"))
      expect(option.querySelector("svg")).not.toBeNull();
    expect(
      document.querySelector('[data-slot="chat-mode-picker"] svg')
    ).not.toBeNull();
    fireEvent.click(screen.getByText("Full access"));
    expect(setMode).toHaveBeenCalledWith("YOLO");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5001);
    });
    expect(onRevert).toHaveBeenCalled();
  });

  it("`/` opens the skills menu and inserts the skill", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.custom("skills.loaded", {
        skills: [
          {
            id: "review",
            name: "review",
            description: "Review a diff",
            location: "",
          },
        ],
      }),
    ]);
    current = await renderRelay(relay, "session");
    await waitFor(() => expect(composer()).toBeTruthy());
    const textarea = field() as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/re", selectionStart: 3 } });
    const option = await screen.findByRole("option", { name: /\/review/ });
    fireEvent.click(option);
    expect(textarea.value).toBe("/review ");
  });

  it("ArrowUp in an empty field edits the last queued message", async () => {
    current = await renderScenario("session-running");
    await waitFor(() => expect(composer()).toBeTruthy());
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(
      await screen.findByRole("textbox", { name: "Edit queued message" })
    ).toBeTruthy();
  });

  it("pasted files are saved under the attachments base", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    const rendered = await renderRelay(relay, "session");
    current = rendered;
    const savePasted = vi
      .spyOn(rendered.runtime.host, "savePasted")
      .mockResolvedValue(["/repo/.attachments/x.png"]);
    await waitFor(() => expect(composer()).toBeTruthy());
    const file = new File([new Uint8Array([1, 2])], "", { type: "image/png" });
    fireEvent.paste(field(), { clipboardData: { files: [file] } });
    await waitFor(() => expect(savePasted).toHaveBeenCalled());
    expect(savePasted.mock.calls[0]![0]).toBe("/repo");
    expect(savePasted.mock.calls[0]![1][0]!.name).toMatch(/\.png$/);
  });
  it.each(["new typing", ""])(
    "a late rejected admission preserves a newer draft %j",
    async (newText) => {
      let reject!: () => void;
      const relay = new FakeRelay({
        onSend: (input) =>
          new Promise((resolve) => {
            reject = () =>
              resolve({
                runId: input.runId,
                status: "rejected",
                reason: "empty",
              });
          }),
      });
      relay.emitAll(b.sessionReady());
      current = await renderRelay(relay, "session");
      fireEvent.change(field(), { target: { value: "first" } });
      fireEvent.keyDown(field(), { key: "Enter" });
      await waitFor(() => expect(reject).toBeTypeOf("function"));
      fireEvent.change(field(), { target: { value: "new typing" } });
      if (newText === "") fireEvent.change(field(), { target: { value: "" } });
      await act(async () => reject());
      expect(sent).not.toHaveBeenCalled();
      expect((field() as HTMLTextAreaElement).value).toBe(newText);
      const alert = screen.getByRole("alert");
      expect(alert.getAttribute("aria-live")).toBe("assertive");
      expect(alert.textContent).toMatch(/didn.t accept/);
      expect(
        alert.compareDocumentPosition(field()) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      fireEvent.change(field(), { target: { value: "retry" } });
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    }
  );

  it("the turn column blocks new-run admission before RUN_STARTED", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    current = await renderRelay(relay, "session", { turnBusy: true });
    fireEvent.change(field(), { target: { value: "steer before events" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() =>
      expect(relay.stats.queue.at(-1)).toMatchObject({
        command: "enqueue",
        input: { message: "steer before events" },
      })
    );
    expect(relay.stats.send).toHaveLength(0);
    expect(sent).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("@ inserts a picked path and IME cannot select a mention", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    const search = vi.fn(async () => ["/repo/src/a.ts"]);
    current = await renderRelay(relay, "session", { mentions: { search } });
    const textarea = field() as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "@a", selectionStart: 2 } });
    const option = await screen.findByRole("option", { name: /a.ts/ });
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    expect(textarea.value).toBe("@a");
    expect(relay.stats.send).toHaveLength(0);
    expect(sent).not.toHaveBeenCalled();
    fireEvent.click(option);
    expect(textarea.value).toContain("/repo/src/a.ts");
  });

  it("picked files remain path attachments; mini and missing-base states", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    const rendered = await renderRelay(relay, "session", {
      mode: "mini",
      attachmentsBase: null,
    });
    current = rendered;
    expect(composer().hasAttribute("data-expanded")).toBe(false);
    fireEvent.focus(field());
    expect(composer().hasAttribute("data-expanded")).toBe(true);
    const pick = vi
      .spyOn(rendered.runtime.host, "pickFiles")
      .mockResolvedValue([{ path: "/repo/report.pdf", name: "report.pdf" }]);
    const save = vi.spyOn(rendered.runtime.host, "savePasted");
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Files or images" })
    );
    await screen.findByText("report.pdf");
    expect(pick).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    fireEvent.paste(field(), {
      clipboardData: {
        files: [new File(["blob"], "x.png", { type: "image/png" })],
      },
    });
    await act(async () => {});
    expect(save).not.toHaveBeenCalled();
    expect(
      document.querySelectorAll(
        '[data-state="uploading"], [data-state="error"]'
      )
    ).toHaveLength(0);
  });
  it.each([true, false])(
    "Mod+. stops only the focused view (%s)",
    async (focused) => {
      const relay = new FakeRelay();
      relay.emitAll([...b.sessionReady(), b.runStarted("r"), b.textStart("a")]);
      current = await renderRelay(relay, "session", {}, { focused });
      fireEvent.keyDown(field(), { key: ".", code: "Period", metaKey: true });
      await act(async () => {});
      expect(relay.stats.cancel).toHaveLength(focused ? 1 : 0);
    }
  );

  it("permission waiting stays busy even before new text arrives", async () => {
    const rendered = await renderScenario("bot-approval-inline");
    current = rendered;
    await waitFor(() => expect(composer()).toBeTruthy());
    fireEvent.change(field(), { target: { value: "after approval" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() =>
      expect(rendered.fixture.relay.stats.queue.at(-1)).toMatchObject({
        command: "enqueue",
        input: { message: "after approval" },
      })
    );
    expect(rendered.fixture.relay.stats.send).toHaveLength(0);
  });

  it("failed pasted files have an error chip and a Remove action", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    const rendered = await renderRelay(relay, "session");
    current = rendered;
    vi.spyOn(rendered.runtime.host, "savePasted").mockRejectedValue(
      new Error("disk full")
    );
    fireEvent.paste(field(), {
      clipboardData: {
        files: [new File(["data"], "x.png", { type: "image/png" })],
      },
    });
    expect(await screen.findByText("disk full")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Remove.*attachment|Remove x.png/ })
    );
    // The strip exits through its reveal animation before it unmounts.
    await waitFor(() => expect(screen.queryByText("disk full")).toBeNull());
  });

  it("reveals the reply preview and the attachment strip in their own rows, in the surface's column", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    current = await renderRelay(relay, "bot");
    expect(document.querySelector('[data-slot="reply-preview"]')).toBeNull();
    expect(
      document.querySelector('[data-slot="composer-attachments"]')
    ).toBeNull();
    act(() => {
      updateDraft("t-1", (draft) => ({
        ...draft,
        replyTo: { messageId: "a", role: "assistant", excerpt: "quoted" },
        attachments: [
          {
            id: "f1",
            name: "x.png",
            size: 12,
            state: "done",
            kind: "path",
            path: "/tmp/x.png",
          } as never,
        ],
      }));
    });
    const reply = document.querySelector<HTMLElement>(
      '[data-slot="reply-preview"]'
    )!;
    const strip = document.querySelector<HTMLElement>(
      '[data-slot="composer-attachments"]'
    )!;
    expect(within(reply).getByText("quoted")).toBeTruthy();
    expect(within(strip).getByText("x.png")).toBeTruthy();
    // Both live inside the surface: the quote first, like a messaging app.
    const surface = document.querySelector<HTMLElement>(
      '[data-slot="composer-surface"]'
    )!;
    expect(surface.contains(strip)).toBe(true);
    expect(surface.contains(reply)).toBe(true);
    expect(composer().contains(reply)).toBe(true);
    // One coordinated motion (motion.ts `composerReveal`): the row mounts at
    // full size and the surface's `layout` spring grows around it while the
    // row only fades; it slides as a `layout="position"` child, never a
    // height tween or a clipped box of its own, so the surface never moves
    // first and the quote second.
    expect(surface.dataset.layout).toBe("layout");
    for (const row of [reply, strip]) {
      expect(row.dataset.layout).toBe("position");
      expect(row.className).not.toContain("overflow-hidden");
      expect(row.style.height).toBe("");
    }
    act(() => {
      updateDraft("t-1", (draft) => ({
        ...draft,
        replyTo: undefined,
        attachments: [],
      }));
    });
    // The preview exits through its reveal animation before it unmounts.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="reply-preview"]')).toBeNull()
    );
    expect(
      document.querySelector('[data-slot="composer-attachments"]')
    ).toBeNull();
  });
});

describe("r2 draft revisions", () => {
  it("increments per thread across updates, mode/model changes and successive clears", () => {
    const initial = draftRevision("t-1");
    const other = draftRevision("other-thread");
    updateDraft("t-1", (draft) => ({ ...draft, text: "typed" }));
    updateDraft("t-1", (draft) => ({ ...draft, text: "" }));
    updateDraft("t-1", (draft) => ({
      ...draft,
      mode: "PLAN" as never,
      model: "chosen",
    }));
    clearDraft("t-1");
    clearDraft("t-1");
    expect(draftRevision("t-1")).toBe(initial + 5);
    expect(draftRevision("other-thread")).toBe(other);
  });

  it.each(["queue", "rejected", "stale", "exception"])(
    "%s restoration respects the revision captured after clearing",
    async (path) => {
      const relay = new FakeRelay();
      relay.emitAll(b.sessionReady());
      const rendered = await renderRelay(relay, "session", {
        turnBusy: path === "queue",
      });
      current = rendered;
      let settle!: () => void;
      if (path === "queue")
        vi.spyOn(rendered.runtime.queue, "enqueue").mockImplementation(
          () =>
            new Promise((_, reject) => {
              settle = () => reject(new Error("failed"));
            })
        );
      else
        vi.spyOn(rendered.runtime.session("t-1"), "submit").mockImplementation(
          () =>
            new Promise((resolve, reject) => {
              settle = () =>
                path === "exception"
                  ? reject(new Error("failed"))
                  : resolve({ kind: path as "rejected" | "stale" });
            })
        );
      fireEvent.change(field(), { target: { value: "sent draft" } });
      const before = draftRevision("t-1");
      fireEvent.keyDown(field(), { key: "Enter" });
      expect(draftRevision("t-1")).toBe(before + 1);
      // An update can deliberately retain object identity. It still advances revision.
      act(() => updateDraft("t-1", (draft) => draft));
      await act(async () => settle());
      expect(draftStore.state["t-1"]!.text).toBe("");
      expect(draftRevision("t-1")).toBe(before + 2);
    }
  );
});

it.each(["bot", "session"] as const)(
  "%s sends once after acceptance and stays silent on retry",
  async (skin) => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    const view = await renderRelay(relay, skin);
    current = view;
    fireEvent.change(field(), { target: { value: "hello" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(sent).toHaveBeenCalledOnce());
    sent.mockClear();
    await view.runtime.session("t-1").retry(undefined, "hello");
    expect(sent).not.toHaveBeenCalled();
  }
);
it("stays silent when the host cannot accept the send", async () => {
  const relay = new FakeRelay({
    onSend: () => {
      throw new ORPCError("HOST_UNAVAILABLE");
    },
  });
  relay.emitAll(b.sessionReady());
  const view = await renderRelay(relay, "session");
  current = view;
  fireEvent.change(field(), { target: { value: "hello" } });
  fireEvent.keyDown(field(), { key: "Enter" });
  await waitFor(() => expect(relay.stats.send).toHaveLength(1));
  await waitFor(() =>
    expect(view.runtime.session("t-1").hostStore.state.outbox[0]?.state).toBe(
      "failed"
    )
  );
  expect(sent).not.toHaveBeenCalled();
});

it("plays once when an admission race queues the accepted message", async () => {
  const relay = new FakeRelay({
    onSend: () => {
      throw new ORPCError("CONFLICT");
    },
  });
  relay.emitAll(b.sessionReady());
  current = await renderRelay(relay, "session");
  fireEvent.change(field(), { target: { value: "hello" } });
  fireEvent.keyDown(field(), { key: "Enter" });
  await waitFor(() => expect(sent).toHaveBeenCalledOnce());
  expect(relay.stats.send).toHaveLength(1);
  expect(relay.stats.queue.at(-1)).toMatchObject({ command: "enqueue" });
});
