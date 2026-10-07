import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { Store } from "@tanstack/react-store";
import { act, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { BrowserSurface } from ".";

it("runtime state refreshes keep the same native candidate until its generation changes", () => {
  const unregister = vi.fn();
  const presenter = {
    captures: new Store<Record<string, string>>({}),
    owner: new Store<string | null>(null),
    refresh: vi.fn(async () => {}),
    activate: vi.fn(async () => {}),
    register: vi.fn(() => unregister),
  };
  const lease = {
    conversationKey: sessionConversationKey("workspace", "session"),
    resourceId: "browser",
    generation: 1,
  };
  const blocked = () => false;
  const view = render(
    <BrowserSurface
      lease={lease}
      presenter={presenter}
      blocked={blocked}
      visible
    />
  );
  view.rerender(
    <BrowserSurface
      lease={{ ...lease }}
      presenter={presenter}
      blocked={blocked}
      visible
    />
  );
  expect(presenter.register).toHaveBeenCalledTimes(1);
  expect(unregister).not.toHaveBeenCalled();
  view.rerender(
    <BrowserSurface
      lease={{ ...lease, generation: 2 }}
      presenter={presenter}
      blocked={blocked}
      visible
    />
  );
  expect(unregister).toHaveBeenCalledTimes(1);
  expect(presenter.register).toHaveBeenCalledTimes(2);
  view.unmount();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("retains inactive leases without monitoring them, and resumes when selected", async () => {
  vi.useFakeTimers();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const disconnect = vi.fn();
  const observe = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = observe;
      disconnect = disconnect;
    }
  );
  type Candidate = Parameters<
    ComponentProps<typeof BrowserSurface>["presenter"]["register"]
  >[0];
  const candidates = new Map<string, Candidate>();
  const presenter = {
    captures: new Store<Record<string, string>>({}),
    owner: new Store<string | null>(null),
    refresh: vi.fn(async () => {}),
    activate: vi.fn(async () => {}),
    register: vi.fn((candidate: Candidate) => {
      candidates.set(candidate.id, candidate);
      return () => candidates.delete(candidate.id);
    }),
  };
  const props = {
    lease: {
      conversationKey: "k" as never,
      resourceId: "browser-one",
      generation: 1,
    },
    presenter,
    blocked: () => false,
  };
  const view = render(<BrowserSurface {...props} visible={false} />);
  expect(candidates.size).toBe(1);
  const candidate = [...candidates.values()][0]!;
  expect(candidate.visible()).toBe(false);
  presenter.refresh.mockClear();
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(presenter.refresh).not.toHaveBeenCalled();
  expect(observe).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);

  view.rerender(<BrowserSurface {...props} visible />);
  expect(presenter.register).toHaveBeenCalledOnce();
  expect(candidates.get(candidate.id)).toBe(candidate);
  expect(observe).toHaveBeenCalledOnce();
  expect(frames.size).toBe(1);
  presenter.refresh.mockClear();
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(presenter.refresh).toHaveBeenCalledOnce();

  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue("hidden");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(frames.size).toBe(0);
  presenter.refresh.mockClear();
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(presenter.refresh).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(frames.size).toBe(1);
  expect(presenter.refresh).toHaveBeenCalledOnce();

  view.rerender(<BrowserSurface {...props} visible={false} />);
  expect(disconnect).toHaveBeenCalledOnce();
  expect(frames.size).toBe(0);
  presenter.refresh.mockClear();
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(presenter.refresh).not.toHaveBeenCalled();
  expect(candidates.get(candidate.id)).toBe(candidate);
  view.unmount();
  expect(candidates.size).toBe(0);
});
