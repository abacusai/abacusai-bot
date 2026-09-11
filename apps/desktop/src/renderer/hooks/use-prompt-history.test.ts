/**
 * Walking the history, by the rules the gesture comes with.
 *
 * Up goes back, down comes forward, and stepping past the newest entry returns
 * whatever was being typed when the walk began — losing that draft is the one
 * thing a shell never does to you.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePromptHistory } from "./use-prompt-history";

const listPromptHistory = vi.fn(async (_scope: string) => [
  "newest",
  "middle",
  "oldest",
]);
const addPromptHistory = vi.fn(async (_scope: string, prompt: string) => [
  prompt,
  "newest",
]);

beforeEach(() => {
  vi.clearAllMocks();
  listPromptHistory.mockResolvedValue(["newest", "middle", "oldest"]);
  (globalThis.window as unknown as { api: unknown }).api = {
    agent: { listPromptHistory, addPromptHistory },
  };
});

const mounted = async (expected = 3) => {
  const view = renderHook(() => usePromptHistory("session-1"));
  // Waiting on the call is not waiting on the state it sets — walking the
  // history before it lands is how this test flaked.
  await waitFor(() => expect(view.result.current.size).toBe(expected));

  return view;
};

describe("switching composers", () => {
  it("swaps to the new scope's list and ends the walk", async () => {
    listPromptHistory.mockImplementation(async (scope: string) =>
      scope === "session-1" ? ["one-newest", "one-old"] : ["two-only"]
    );
    const view = renderHook(({ scope }) => usePromptHistory(scope), {
      initialProps: { scope: "session-1" },
    });
    await waitFor(() => expect(view.result.current.size).toBe(2));
    act(() => {
      view.result.current.previous("");
    });
    expect(view.result.current.browsing).toBe(true);

    view.rerender({ scope: "session-2" });
    await waitFor(() => expect(view.result.current.size).toBe(1));

    // Another chat's prompts never surface, and the walk started in the old
    // chat does not carry over.
    expect(view.result.current.browsing).toBe(false);
    let shown: string | null = null;
    act(() => {
      shown = view.result.current.previous("");
    });
    expect(shown).toBe("two-only");
  });
});

describe("walking back", () => {
  it("starts at the most recent prompt", async () => {
    const { result } = await mounted();

    expect(result.current.previous("")).toBe("newest");
  });

  it("keeps going back, then stops at the oldest", async () => {
    const { result } = await mounted();

    act(() => {
      result.current.previous("");
      result.current.previous("");
    });
    expect(result.current.previous("")).toBe("oldest");
    // Nothing further back; the box keeps what it has rather than clearing.
    expect(result.current.previous("")).toBe(null);
  });

  it("has nothing to offer when nothing was ever sent", async () => {
    listPromptHistory.mockResolvedValue([]);
    const { result } = await mounted(0);

    expect(result.current.previous("half-typed")).toBe(null);
  });
});

describe("coming back", () => {
  it("returns the draft that was in the box", async () => {
    const { result } = await mounted();

    act(() => {
      result.current.previous("half-typed thought");
    });
    expect(result.current.next()).toBe("half-typed thought");
  });

  it("walks forward through the entries on the way", async () => {
    const { result } = await mounted();

    act(() => {
      result.current.previous("");
      result.current.previous("");
    });

    expect(result.current.next()).toBe("newest");
  });

  it("does nothing when the walk never started", async () => {
    const { result } = await mounted();

    expect(result.current.next()).toBe(null);
  });
});

describe("leaving the history", () => {
  it("starts the next walk from the top after typing", async () => {
    const { result } = await mounted();

    act(() => {
      result.current.previous("");
      result.current.previous("");
      result.current.reset();
    });

    expect(result.current.previous("")).toBe("newest");
  });

  it("records a sent prompt and stops browsing", async () => {
    const { result } = await mounted();

    act(() => {
      result.current.previous("");
    });
    expect(result.current.browsing).toBe(true);

    act(() => {
      result.current.remember("a new instruction");
    });

    expect(addPromptHistory).toHaveBeenCalledWith(
      "session-1",
      "a new instruction"
    );
    await waitFor(() => expect(result.current.browsing).toBe(false));
  });

  it("survives a history that cannot be written", async () => {
    addPromptHistory.mockRejectedValue(new Error("EACCES"));
    const { result } = await mounted();

    act(() => {
      result.current.remember("still sent");
    });

    // The send is what matters; the history is a convenience on top of it.
    await waitFor(() => expect(result.current.browsing).toBe(false));
  });
});
