import { expect, it, vi } from "vitest";

import { draftStore, clearDraft, updateDraft } from "./draft-store";

it("imports a synthetic v1.0.85 durable draft once without overwriting a new draft", async () => {
  const { importLegacyDrafts } = await import("./draft-store");
  const acknowledge = vi.fn().mockResolvedValue(undefined);
  const legacy = {
    "old-thread": "unsent legacy words",
    "edited-thread": "old words",
  };
  draftStore.setState(() => ({
    "edited-thread": { text: "new words", attachments: [] },
  }));
  await importLegacyDrafts(legacy, acknowledge);
  expect(draftStore.state["old-thread"]).toEqual({
    text: "unsent legacy words",
    attachments: [],
  });
  expect(draftStore.state["edited-thread"]?.text).toBe("new words");
  expect(
    JSON.parse(sessionStorage.getItem("abacusai-bot:abacus.chat.drafts")!)[
      "old-thread"
    ].text
  ).toBe("unsent legacy words");
  expect(acknowledge).toHaveBeenCalledWith(["old-thread", "edited-thread"]);
  clearDraft("old-thread");
  await importLegacyDrafts(legacy, acknowledge);
  expect(draftStore.state["old-thread"]?.text).toBe("");
});

it("writes drafts to sessionStorage once per burst of keystrokes, and on pagehide", () => {
  vi.useFakeTimers();
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  try {
    // Flush whatever the test before scheduled on the real clock.
    window.dispatchEvent(new Event("pagehide"));
    setItem.mockClear();
    for (const text of ["h", "he", "hel", "hell", "hello"])
      updateDraft("typing", (draft) => ({ ...draft, text }));
    expect(setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(sessionStorage.getItem("abacusai-bot:abacus.chat.drafts")!)
        .typing.text
    ).toBe("hello");
    updateDraft("typing", (draft) => ({ ...draft, text: "hello!" }));
    window.dispatchEvent(new Event("pagehide"));
    expect(setItem).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(250);
    expect(setItem).toHaveBeenCalledTimes(2);
  } finally {
    setItem.mockRestore();
    vi.useRealTimers();
  }
});

it("flushes a pending draft write when the page is hidden", () => {
  vi.useFakeTimers();
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  const visibility = vi.spyOn(document, "visibilityState", "get");
  try {
    window.dispatchEvent(new Event("pagehide"));
    setItem.mockClear();
    updateDraft("hidden", (draft) => ({ ...draft, text: "before freeze" }));
    expect(setItem).not.toHaveBeenCalled();
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(sessionStorage.getItem("abacusai-bot:abacus.chat.drafts")!)
        .hidden.text
    ).toBe("before freeze");
    // Nothing pending: hiding again writes nothing, and typing after the
    // page is shown again schedules a write as usual.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(setItem).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    updateDraft("hidden", (draft) => ({ ...draft, text: "after" }));
    vi.advanceTimersByTime(250);
    expect(setItem).toHaveBeenCalledTimes(2);
  } finally {
    visibility.mockRestore();
    setItem.mockRestore();
    vi.useRealTimers();
  }
});

it("writes a pendingSubmit change at once", () => {
  vi.useFakeTimers();
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  try {
    window.dispatchEvent(new Event("pagehide"));
    setItem.mockClear();
    const pendingSubmit = { id: "submit-1" } as never;
    updateDraft("sending", (draft) => ({
      ...draft,
      text: "go",
      pendingSubmit,
    }));
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(sessionStorage.getItem("abacusai-bot:abacus.chat.drafts")!)
        .sending.pendingSubmit
    ).toEqual({ id: "submit-1" });
    clearDraft("sending");
    expect(setItem).toHaveBeenCalledTimes(2);
    // Typing alone still waits for the batch.
    updateDraft("sending", (draft) => ({ ...draft, text: "next" }));
    expect(setItem).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(250);
    expect(setItem).toHaveBeenCalledTimes(3);
  } finally {
    setItem.mockRestore();
    vi.useRealTimers();
  }
});
