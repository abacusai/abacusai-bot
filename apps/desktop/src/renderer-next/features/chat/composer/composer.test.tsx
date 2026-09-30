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

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { renderRelay, renderScenario, renderWithDb } from "../testing";
import { ModeChip } from "./chips";
import { useComposerExpanded } from "./composer";
import { clearDraft, updateDraft } from "./draft-store";

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
});
