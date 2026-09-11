/**
 * What the Memory panel says when a delete does not happen.
 *
 * The store refuses to write while another session holds it, rather than racing
 * that session and losing one of the two writes. That refusal has to reach the
 * screen: the entries are still there, and re-rendering the same list without a
 * word would read as "deleted" to the person who just clicked.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The panel renders translated strings; the keys are what the assertions read.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import type { MemorySnapshot } from "#shared/contracts";

const { MemoryPanel } = await import("./memory-panel");

/**
 * Both stores carry an entry, so clearing one leaves the list on screen. A
 * snapshot that empties completely would swap the whole list for the "nothing
 * remembered" line, and an assertion that the message is gone would then pass
 * because the section it lives in is gone too.
 */
const snapshot: MemorySnapshot = {
  memory: ["The build needs Node 22."],
  user: ["Prefers short answers."],
  remember: ["I like blue."],
};

const listMemories = vi.fn(async (): Promise<MemorySnapshot> => snapshot);
const forgetMemory = vi.fn();
const forgetAllMemories = vi.fn();
const listBotMemories = vi.fn(async () => [
  {
    botId: "bot-1",
    name: "Scout",
    entries: ["The user's dog is called Rex."],
    noteDays: 2,
  },
]);
const forgetBotMemory = vi.fn(async () => []);
const clearBotMemory = vi.fn(async () => []);
const getCustomInstructions = vi.fn(async (): Promise<string> => "");
const setCustomInstructions = vi.fn(async (text: string): Promise<string> =>
  text.trim()
);

const byId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-id="${id}"]`);

const mount = async (readyId = "memory-section-memory"): Promise<void> => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  render(
    (
      <QueryClientProvider client={client}>
        <MemoryPanel />
      </QueryClientProvider>
    ) as JSX.Element
  );
  await waitFor(() => expect(byId(readyId)).toBeTruthy());
};

beforeEach(() => {
  listMemories.mockClear();
  // Not just mockClear: a mockResolvedValue set by one test outlives it, and
  // an empty snapshot leaking forward removes the section the others click in.
  listMemories.mockResolvedValue(snapshot);
  forgetMemory.mockClear();
  forgetAllMemories.mockClear();

  getCustomInstructions.mockClear();
  setCustomInstructions.mockClear();
  getCustomInstructions.mockResolvedValue("");

  listBotMemories.mockClear();
  forgetBotMemory.mockClear();
  clearBotMemory.mockClear();

  (globalThis.window as unknown as { api: unknown }).api = {
    agent: {
      listMemories,
      forgetMemory,
      forgetAllMemories,
      listBotMemories,
      forgetBotMemory,
      clearBotMemory,
      getCustomInstructions,
      setCustomInstructions,
    },
  };
});

describe("the bots section", () => {
  it("lists each bot's core memory under its name, apart from the session stores", async () => {
    await mount();
    await waitFor(() => expect(byId("memory-bots")).toBeTruthy());

    expect(byId("memory-sessions-heading")).toBeTruthy();
    expect(byId("memory-bot-bot-1")?.textContent).toContain("Scout");
    expect(byId("memory-bot-entry-bot-1-0")?.textContent).toContain("Rex");
  });

  it("forgets a bot entry through the bot store, not the session one", async () => {
    await mount();
    await waitFor(() => expect(byId("memory-bot-forget-bot-1-0")).toBeTruthy());

    byId("memory-bot-forget-bot-1-0")?.click();

    await waitFor(() =>
      expect(forgetBotMemory).toHaveBeenCalledWith({
        botId: "bot-1",
        index: 0,
        entry: "The user's dog is called Rex.",
      })
    );
    expect(forgetMemory).not.toHaveBeenCalled();
  });
});

describe("a delete the store refused", () => {
  it("says so instead of re-rendering the same list in silence", async () => {
    forgetAllMemories.mockRejectedValue(
      new Error("Memory is being updated by another session right now.")
    );
    await mount();

    fireEvent.click(byId("memory-clear-memory") as HTMLElement);
    fireEvent.click(byId("memory-clear-confirm-memory") as HTMLElement);

    await waitFor(() => expect(byId("memory-write-error")).toBeTruthy());
    expect(byId("memory-write-error")?.textContent).toBe("memory.writeFailed");
    // The entry is still there, which is the truth the message is about.
    expect(byId("memory-section-memory")?.textContent).toContain(
      "The build needs Node 22."
    );
  });

  it("takes the message back down once a delete succeeds", async () => {
    // Asserting on a fresh mount would prove nothing: the message starts
    // hidden. It has to be shown first, so that clearing it is what is
    // measured — otherwise a panel that never clears it passes.
    forgetAllMemories.mockRejectedValueOnce(new Error("busy"));
    await mount();

    const clear = (): void => {
      fireEvent.click(byId("memory-clear-memory") as HTMLElement);
      fireEvent.click(byId("memory-clear-confirm-memory") as HTMLElement);
    };

    clear();
    await waitFor(() => expect(byId("memory-write-error")).toBeTruthy());

    forgetAllMemories.mockResolvedValueOnce({
      memory: [],
      user: snapshot.user,
    });
    clear();

    await waitFor(() => expect(byId("memory-write-error")).toBeNull());
  });
});

/**
 * The one field on this page the user writes, rather than the agent.
 */
describe("custom instructions", () => {
  const box = (): HTMLTextAreaElement =>
    byId("memory-instructions-input") as HTMLTextAreaElement;

  it("shows what is already stored", async () => {
    getCustomInstructions.mockResolvedValue("Answer in British English.");
    await mount();

    await waitFor(() => expect(box().value).toBe("Answer in British English."));
  });

  it("is editable before anything has been remembered", async () => {
    // The lists below collapse to a "nothing remembered" line when empty. The
    // box must not go with them: an empty agent is exactly when someone sits
    // down to tell it how to behave.
    listMemories.mockResolvedValue({ memory: [], user: [], remember: [] });
    await mount("memory-instructions-input");

    // The box renders independently of the lists, so wait for the lists to
    // settle before asserting they collapsed — otherwise this races the query.
    await waitFor(() => expect(byId("memory-empty")).toBeTruthy());
    expect(box()).toBeTruthy();
  });

  it("keeps a draft out of the prompt until it is saved", async () => {
    await mount();

    fireEvent.change(box(), { target: { value: "Half a thou" } });

    expect(setCustomInstructions).not.toHaveBeenCalled();

    fireEvent.click(byId("memory-instructions-save") as HTMLElement);

    await waitFor(() =>
      expect(setCustomInstructions).toHaveBeenCalledWith("Half a thou")
    );
  });

  it("will not save when nothing was changed", async () => {
    getCustomInstructions.mockResolvedValue("Be terse.");
    await mount();

    await waitFor(() => expect(box().value).toBe("Be terse."));
    expect(
      (byId("memory-instructions-save") as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("says so when the write fails, rather than looking saved", async () => {
    setCustomInstructions.mockRejectedValue(new Error("read-only volume"));
    await mount();

    fireEvent.change(box(), { target: { value: "Never use emoji." } });
    fireEvent.click(byId("memory-instructions-save") as HTMLElement);

    await waitFor(() =>
      expect(byId("memory-instructions-error")?.textContent).toBe(
        "memory.instructions.saveFailed"
      )
    );
  });
});
