/**
 * The dictation state (canvas ComposerStates "Dictating", Pickers
 * "Dictation, from resting to done"): the mic swaps the surface's content
 * for a red dot, the live waveform, an `m:ss` timer and Stop in the send
 * slot; the transcript flows into the field on stop; Escape cancels; the
 * host's preview flag shows the same row without a recorder; reduced motion
 * holds the bars still. The plumbing (`useConnectedDictation`) is mocked.
 */
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { renderRelay, renderScenario } from "../testing";
import { formatElapsed } from "./composer";
import { clearDraft } from "./draft-store";

type VoiceState = "idle" | "starting" | "recording" | "transcribing" | "error";

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const voice = {
    state: { state: "idle" as VoiceState, level: 0 },
    transcript: null as ((text: string) => void) | null,
    start: vi.fn(() => Promise.resolve()),
    end: vi.fn(() => Promise.resolve()),
    cancel: vi.fn(),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: { state: VoiceState; level?: number }) {
      voice.state = { level: voice.state.level, ...next };
      for (const listener of listeners) listener();
    },
  };
  return voice;
});

vi.mock("#renderer/lib/voice/use-dictation", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useConnectedDictation: (
      _sessionId: string,
      onTranscript: (text: string) => void
    ) => {
      mocks.transcript = onTranscript;
      const snapshot = useSyncExternalStore(mocks.subscribe, () => mocks.state);
      return {
        ...snapshot,
        error: null,
        start: mocks.start,
        end: mocks.end,
        cancel: mocks.cancel,
      };
    },
  };
});

let current: { cleanup(): Promise<void> } | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await current?.cleanup();
  current = null;
  clearDraft("t-1");
  act(() => mocks.set({ state: "idle", level: 0 }));
  mocks.start.mockClear();
  mocks.end.mockClear();
  mocks.cancel.mockClear();
});

const composer = () =>
  document.querySelector('[data-slot="composer"]') as HTMLElement;
const surface = () =>
  document.querySelector('[data-slot="composer-surface"]') as HTMLElement;
const row = () =>
  document.querySelector<HTMLElement>('[data-slot="composer-dictation"]');

describe("composer dictation", () => {
  it("formats the elapsed time as m:ss", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(7)).toBe("0:07");
    expect(formatElapsed(65)).toBe("1:05");
    expect(formatElapsed(600)).toBe("10:00");
  });

  it("the mic swaps the pill to the dictating state; Stop ends it and the transcript lands in the field", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    current = await renderRelay(relay, "bot");
    await waitFor(() => expect(composer()).toBeTruthy());
    expect(row()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    expect(mocks.start).toHaveBeenCalledTimes(1);
    act(() => mocks.set({ state: "starting" }));
    expect(row()!.dataset.state).toBe("starting");
    expect(row()!.textContent).toBe("Getting dictation ready");
    act(() => mocks.set({ state: "recording", level: 0.5 }));
    // The row: the composer is "dictating", the pill shape, no text area;
    // a red dot, seven 3 px bars following the level, the timer, Stop in
    // the send slot (focused, so Escape reaches the composer).
    expect(composer().dataset.state).toBe("dictating");
    expect(composer().hasAttribute("data-expanded")).toBe(false);
    expect(surface().dataset.radius).toBe("24");
    expect(within(surface()).queryByRole("textbox")).toBeNull();
    expect(row()!.dataset.state).toBe("recording");
    const wave = surface().querySelector<HTMLElement>(
      '[data-slot="composer-wave"]'
    )!;
    expect(wave.hasAttribute("data-live")).toBe(true);
    const bars = [...wave.children] as HTMLElement[];
    expect(bars).toHaveLength(7);
    expect(bars[2]!.style.transform).toBe("scaleY(0.65)");
    act(() => mocks.set({ state: "recording", level: 1 }));
    expect(bars[2]!.style.transform).toBe("scaleY(1.00)");
    const timer = screen.getByRole("timer", { name: "Recording time" });
    expect(timer.textContent).toBe("0:00");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(65_000);
    });
    expect(timer.textContent).toBe("1:05");
    const stop = screen.getByRole("button", { name: "Stop dictating" });
    expect(document.activeElement).toBe(stop);
    expect(screen.queryByRole("button", { name: "Dictate" })).toBeNull();
    fireEvent.click(stop);
    expect(mocks.end).toHaveBeenCalledTimes(1);
    act(() => mocks.set({ state: "transcribing" }));
    expect(row()!.textContent).toBe("Writing it down");
    act(() => {
      mocks.transcript!("move the review to friday");
      mocks.set({ state: "idle" });
    });
    expect(row()).toBeNull();
    const field = within(composer()).getByRole(
      "textbox"
    ) as HTMLTextAreaElement;
    expect(field.value).toBe("move the review to friday");
    expect(composer().dataset.state).toBe("typing");
  });

  it("Escape cancels the recording and the field comes back", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    current = await renderRelay(relay, "session");
    await waitFor(() => expect(composer()).toBeTruthy());
    act(() => mocks.set({ state: "recording" }));
    expect(row()).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: "Stop dictating" }), {
      key: "Escape",
    });
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    act(() => mocks.set({ state: "idle" }));
    expect(row()).toBeNull();
    expect(within(composer()).getByRole("textbox")).toBeTruthy();
    // The session box is back, with its toolbar.
    expect(composer().hasAttribute("data-expanded")).toBe(true);
  });

  it("the host's preview flag shows the row without a recorder, swaying on CSS", async () => {
    current = await renderScenario("composer-dictating");
    await waitFor(() => expect(row()).toBeTruthy());
    expect(mocks.start).not.toHaveBeenCalled();
    const wave = surface().querySelector<HTMLElement>(
      '[data-slot="composer-wave"]'
    )!;
    expect(wave.hasAttribute("data-live")).toBe(false);
    expect(
      ([...wave.children] as HTMLElement[]).map(
        (bar) => bar.style.animationDelay
      )
    ).toEqual([
      "0ms",
      "-140ms",
      "-280ms",
      "-420ms",
      "-560ms",
      "-700ms",
      "-840ms",
    ]);
    expect(screen.getByRole("timer")).toBeTruthy();
  });
});
