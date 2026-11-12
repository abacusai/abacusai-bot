import { contract } from "@abacus-ai/contract/contract";
import { contextTokensOf } from "@abacus-ai/contract/contract/ai-thread";
import type { ModelAvailability } from "@abacus-ai/contract/models";
import { implement } from "@orpc/server";
import type { StreamChunk } from "@tanstack/ai";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { renderRelay } from "../testing";
import { useChatView } from "./context";
import { switchNeedsAsking } from "./model-switch-guard";

const ROUTER = "abacus/route-llm-code-low";
const FABLE = "abacus/claude-fable-5-1";
const FREE = "openrouter/openai/gpt-oss-20b:free";
const OPEN = "openllm/auto";
const CUSTOM = "mine/llama-4";

const catalog: ModelAvailability[] = [
  {
    id: ROUTER,
    label: "RouteLLM",
    provider: "abacus",
    tier: "default",
    configured: true,
  },
  {
    id: FABLE,
    label: "Claude Fable 5.1",
    provider: "abacus",
    tier: "strong",
    configured: true,
  },
  {
    id: FREE,
    label: "GPT-OSS 20B (free)",
    provider: "openrouter",
    tier: "free",
    configured: true,
  },
  {
    id: OPEN,
    label: "RouteLLM - Open",
    provider: "openllm",
    tier: "fast",
    configured: true,
  },
  {
    id: CUSTOM,
    label: "My Llama",
    provider: "mine",
    tier: "local",
    configured: true,
  },
];

/** One finished turn whose last request sent 612,000 tokens. */
const HISTORY: StreamChunk[] = [
  b.runStarted("r1"),
  ...b.text("r1-u", "user", "Build the renderer for the engine"),
  ...b.text("r1-a", "assistant", "The renderer builds and draws a frame."),
  b.runFinished("r1", "success", {
    metadata: {
      abacus: {
        turnUsage: {
          input: 12_000,
          cacheRead: 600_000,
          cacheWrite: 0,
          output: 400,
          requests: 3,
          model: "router",
        },
      },
    },
  }),
];

/** Fires a switch the way the picker, a card or an upgrade's resume does. */
const Switches = () => {
  const { composer } = useChatView();
  return (
    <div>
      {[FABLE, FREE, OPEN, CUSTOM].map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => composer.model?.onChange(id)}
        >
          {`pick ${id}`}
        </button>
      ))}
      <button
        type="button"
        onClick={() =>
          void composer.onSwitchThisChat?.(FABLE).then((moved) => {
            document.body.dataset.moved = moved;
          })
        }
      >
        resume on fable
      </button>
    </div>
  );
};

let current: Awaited<ReturnType<typeof renderRelay>> | undefined;
afterEach(async () => {
  await current?.cleanup();
  current = undefined;
  delete document.body.dataset.moved;
});

const mount = async ({
  history = true,
  skin = "session" as "session" | "bot",
  continues = true,
  answer = () => Promise.resolve(),
}: {
  history?: boolean;
  skin?: "session" | "bot";
  continues?: boolean;
  answer?: () => Promise<void>;
} = {}) => {
  const picked: Array<string | null> = [];
  const moved: string[] = [];
  const continued: Array<[string, string | undefined]> = [];
  const relay = new FakeRelay();
  relay.emitAll(b.sessionReady());
  const os = implement(contract);
  current = await renderRelay(
    relay,
    skin,
    {
      model: {
        value: ROUTER,
        resolved: ROUTER,
        label: "RouteLLM",
        onChange: (id) => {
          picked.push(id);
        },
        groups: [],
      },
      onSwitchThisChat: vi.fn(async (id: string) => {
        moved.push(id);
        return "chat" as const;
      }),
      ...(continues
        ? {
            onContinueInNewChat: vi.fn(
              async (model: string, prompt?: string) => {
                continued.push([model, prompt]);
                await answer();
              }
            ),
          }
        : {}),
    },
    { slots: { composerNotice: <Switches /> } },
    undefined,
    { models: { list: os.models.list.handler(() => catalog) } }
  );
  if (history) await act(async () => relay.emitAll(HISTORY));
  // The catalog read lands before the first switch.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  return { picked, moved, continued };
};

const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));
const dialog = () => screen.queryByRole("alertdialog");

describe("switchNeedsAsking", () => {
  const strong = {
    id: FABLE,
    label: "",
    provider: "abacus",
    tier: "strong" as const,
  };
  it.each([
    [
      "a billed model in a chat with messages",
      true,
      ROUTER,
      { id: FABLE, row: strong },
      true,
    ],
    ["an empty chat", false, ROUTER, { id: FABLE, row: strong }, false],
    [
      "the model the chat is on",
      true,
      FABLE,
      { id: FABLE, row: strong },
      false,
    ],
    [
      "the free pool",
      true,
      ROUTER,
      { id: OPEN, row: { ...strong, id: OPEN, tier: "fast" as const } },
      false,
    ],
    [
      "another provider's free model",
      true,
      ROUTER,
      {
        id: FREE,
        row: {
          ...strong,
          id: FREE,
          provider: "openrouter",
          tier: "free" as const,
        },
      },
      false,
    ],
    [
      "an Abacus model a free plan's catalog lists as free, which still spends credits",
      true,
      ROUTER,
      {
        id: FABLE,
        row: { ...strong, tier: "free" as const },
      },
      true,
    ],
    [
      "a custom or local endpoint, which bills its owner",
      true,
      ROUTER,
      {
        id: "local/q",
        row: { ...strong, id: "local/q", tier: "local" as const },
      },
      true,
    ],
    [
      "a model the catalog has not listed yet",
      true,
      ROUTER,
      { id: FABLE, row: null },
      true,
    ],
  ])("%s", (_, hasMessages, currentId, target, asked) => {
    expect(switchNeedsAsking({ hasMessages, current: currentId, target })).toBe(
      asked
    );
  });
});

describe("contextTokensOf", () => {
  it("adds up what the last request sent, and is undefined when nothing is known", () => {
    expect(
      contextTokensOf({
        abacus: { turnUsage: { input: 12, cacheRead: 600, cacheWrite: 30 } },
      })
    ).toBe(642);
    expect(
      contextTokensOf({
        abacus: { turnUsage: { input: 0, cacheRead: 0, cacheWrite: 0 } },
      })
    ).toBeUndefined();
    expect(contextTokensOf({ abacus: {} })).toBeUndefined();
    expect(contextTokensOf(null)).toBeUndefined();
  });
});

describe("a model switch in a chat with messages", () => {
  it("says what the switch costs, with the chat's size, and takes the new chat on that model", async () => {
    const h = await mount();
    click(`pick ${FABLE}`);
    const asked = await screen.findByRole("alertdialog");
    expect(asked.textContent).toContain(
      "Continue with Claude Fable 5.1 in a new chat?"
    );
    expect(asked.textContent).toContain("This chat is about 612K tokens long.");
    expect(asked.textContent).toContain(
      "Prompt caching doesn't carry over to a new model"
    );
    expect(asked.textContent).toContain("same folder with the same files");
    click("Continue in a new chat with Claude Fable 5.1");
    await waitFor(() => expect(dialog()).toBeNull());
    expect(h.continued).toEqual([[FABLE, undefined]]);
    // This chat kept its model.
    expect(h.picked).toEqual([]);
  });

  it("switches this chat only when the user says so", async () => {
    const h = await mount();
    click(`pick ${FABLE}`);
    await screen.findByRole("alertdialog");
    click("Switch this chat to Claude Fable 5.1 anyway");
    await waitFor(() => expect(dialog()).toBeNull());
    expect(h.picked).toEqual([FABLE]);
    expect(h.continued).toEqual([]);
  });

  it("changes nothing on Cancel", async () => {
    const h = await mount();
    click(`pick ${FABLE}`);
    await screen.findByRole("alertdialog");
    click("Cancel");
    await waitFor(() => expect(dialog()).toBeNull());
    expect(h.picked).toEqual([]);
    expect(h.continued).toEqual([]);
  });

  it("keeps the dialog for another try when the new chat could not be prepared", async () => {
    const h = await mount({
      answer: () => Promise.reject(new Error("failed")),
    });
    click(`pick ${FABLE}`);
    await screen.findByRole("alertdialog");
    click("Continue in a new chat with Claude Fable 5.1");
    expect(
      await screen.findByText("Couldn't start the new chat. Try again.")
    ).toBeTruthy();
    expect(dialog()).not.toBeNull();
    expect(h.picked).toEqual([]);
  });

  it("sends the waiting message to the new chat when an upgrade's resume asks to move", async () => {
    const h = await mount();
    click("resume on fable");
    await screen.findByRole("alertdialog");
    click("Continue in a new chat with Claude Fable 5.1");
    await waitFor(() => expect(document.body.dataset.moved).toBe("new-chat"));
    expect(h.continued).toEqual([[FABLE, "Build the renderer for the engine"]]);
    // This chat neither moved nor ran again.
    expect(h.moved).toEqual([]);
  });

  it("answers cancelled to a resume the user called off", async () => {
    const h = await mount();
    click("resume on fable");
    await screen.findByRole("alertdialog");
    click("Cancel");
    await waitFor(() => expect(document.body.dataset.moved).toBe("cancelled"));
    expect(h.moved).toEqual([]);
  });

  it("warns about cost, not credits, for an endpoint the user runs themselves", async () => {
    const h = await mount();
    click(`pick ${CUSTOM}`);
    const asked = await screen.findByRole("alertdialog");
    expect(asked.textContent).toContain(
      "one message can cost as much as dozens of normal ones"
    );
    expect(asked.textContent).not.toContain("credits");
    click("Switch this chat to My Llama anyway");
    await waitFor(() => expect(h.picked).toEqual([CUSTOM]));
  });

  it("offers only the switch and Cancel where there is no new chat to start (a bot's chat)", async () => {
    const h = await mount({ skin: "bot", continues: false });
    click(`pick ${FABLE}`);
    const asked = await screen.findByRole("alertdialog");
    expect(asked.textContent).toContain(
      "Switch this chat to Claude Fable 5.1?"
    );
    expect(screen.queryByRole("button", { name: /new chat/ })).toBeNull();
    click("Switch this chat to Claude Fable 5.1 anyway");
    await waitFor(() => expect(h.picked).toEqual([FABLE]));
  });

  it.each([
    ["a free model", FREE],
    ["the free pool", OPEN],
  ])("does not ask for %s, which costs nothing", async (_, id) => {
    const h = await mount();
    click(`pick ${id}`);
    await waitFor(() => expect(h.picked).toEqual([id]));
    expect(dialog()).toBeNull();
  });

  it("does not ask in a chat with no messages yet", async () => {
    const h = await mount({ history: false });
    click(`pick ${FABLE}`);
    await waitFor(() => expect(h.picked).toEqual([FABLE]));
    expect(dialog()).toBeNull();
  });
});
