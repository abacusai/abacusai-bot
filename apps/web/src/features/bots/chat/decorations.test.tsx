/**
 * R3-T19 (decorations): what the bot skin's `decorateMessage` returns per
 * message: silent turns hidden, the reaction badge and the dropped emoji
 * reply, one deliverables card whose rows open through the route's
 * callbacks, and feedback only with an Abacus account, never on the live
 * run, `clear` on a re-click, keyed by the reply's text part.
 */
import { feedbackSegmentId } from "@abacus-ai/contract/transcript/feedback-target";
import type { UIMessage } from "@tanstack/ai-client";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import * as turns from "#renderer/lib/bot-turns/turns";
import { i18n, initI18n } from "#renderer/lib/i18n";

import {
  botMessageDecorations,
  type BotDecorationOptions,
} from "./decorations";

// Share reads the account, which these cards are not mounted under here.
vi.mock("#renderer/components/share/share-row-button", () => ({
  ShareRowButton: () => null,
}));

vi.mock("#renderer/lib/bot-turns/turns", async (importOriginal) => {
  const actual = await importOriginal<typeof turns>();
  return { ...actual, botThreadView: vi.fn(actual.botThreadView) };
});

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en-US");
});

type Part = UIMessage["parts"][number];
const text = (content: string): Part => ({ type: "text", content }) as Part;
const tool = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  content = ""
): Part[] => [
  {
    type: "tool-call",
    id,
    name,
    arguments: JSON.stringify(input),
    input,
    state: "complete",
  } as unknown as Part,
  {
    type: "tool-result",
    toolCallId: id,
    content: JSON.stringify({ text: content, rejected: false }),
    state: "complete",
  } as unknown as Part,
];
const msg = (
  id: string,
  role: "user" | "assistant",
  parts: Part[],
  metadata?: Record<string, unknown>
): UIMessage => ({ id, role, parts, ...(metadata ? { metadata } : {}) });

const options = (
  overrides: Partial<BotDecorationOptions> = {}
): BotDecorationOptions => ({
  sessionId: "s-1",
  model: "m-1",
  feedbackEnabled: true,
  sendFeedback: vi.fn(async () => ({ ok: true })),
  workspaceRoot: "/w",
  onOpenFile: vi.fn(),
  onOpenUrl: vi.fn(),
  onOpenExternal: vi.fn(),
  onReveal: vi.fn(),
  ...overrides,
});

const thread: UIMessage[] = [
  msg("u1", "user", [text("Make it")]),
  msg("a1", "assistant", [
    ...tool("c1", "react_to_message", { emoji: "👍" }, '{"emoji":"👍"}'),
  ]),
  msg("a2", "assistant", [text("👍")]),
  msg("a3", "assistant", [
    text("Here is the report."),
    ...tool("c2", "write", { file_path: "out/report.pdf" }),
  ]),
  msg("u2", "user", [text("Thanks")]),
  msg("a4", "assistant", tool("c3", "bash", { command: "ls" })),
];

const decorateAll = (
  decorate: ReturnType<typeof botMessageDecorations>,
  messages: readonly UIMessage[],
  runActive = false
) =>
  messages.map((message, index) =>
    decorate(message, { messages, index, runActive })
  );

const show = (node: ReactNode) => render(<>{node}</>);

describe("botMessageDecorations", () => {
  it("hides the silent turn and the repeated emoji, badges the user message", () => {
    const d = decorateAll(botMessageDecorations(options()), thread);
    expect(d.map((x) => x?.hidden === true)).toEqual([
      false,
      true,
      true,
      false,
      false,
      true,
    ]);
    show(d[0]!.badge);
    expect(
      screen.getByRole("img", { name: "Agent reacted with 👍" })
    ).toBeTruthy();
  });

  it("derives the thread once per messages array", () => {
    const spy = vi.mocked(turns.botThreadView);
    spy.mockClear();
    decorateAll(botMessageDecorations(options()), thread);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("puts one card after the turn's last shown message; rows open through the route", () => {
    const opts = options();
    const d = decorateAll(botMessageDecorations(opts), thread);
    show(d[3]!.after);
    expect(screen.getAllByText("report.pdf")).toHaveLength(1);
    fireEvent.click(screen.getByText("report.pdf"));
    expect(opts.onOpenFile).toHaveBeenCalledWith("/w/out/report.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    expect(opts.onReveal).toHaveBeenCalledWith("/w/out/report.pdf");
  });

  it("offers no feedback without an Abacus account", () => {
    const d = decorateAll(
      botMessageDecorations(options({ feedbackEnabled: false })),
      [msg("u", "user", [text("hi")]), msg("a", "assistant", [text("Hello")])]
    );
    expect(d[1]?.after).toBeUndefined();
  });

  it("offers one rating per turn, on its last spoken reply", () => {
    const d = decorateAll(botMessageDecorations(options()), [
      msg("u1", "user", [text("hi")]),
      msg("a1", "assistant", [text("First")]),
      msg("a2", "assistant", [text("Second")]),
      msg("u2", "user", [text("more")]),
      msg("a3", "assistant", [text("Third")]),
    ]);
    expect(d.map((x) => x?.after != null)).toEqual([
      false,
      false,
      true,
      false,
      true,
    ]);
  });

  it("never on the live run", () => {
    const messages = [
      msg("u", "user", [text("hi")]),
      msg("a", "assistant", [text("Hello")]),
    ];
    const d = decorateAll(botMessageDecorations(options()), messages, true);
    expect(d[1]?.after).toBeUndefined();
  });

  it("rates, and a second click clears", async () => {
    const opts = options();
    const messages = [
      msg("u", "user", [text("hi")]),
      // Migrated from v1: the reply is rated by its text part's segment.
      msg(
        "seg-1",
        "assistant",
        [
          { type: "thinking", content: "hm" } as Part,
          {
            type: "text",
            content: "Hello",
            metadata: { abacus: { segmentId: "seg-7" } },
          } as Part,
        ],
        { abacus: { segments: [{ id: "seg-1" }, { id: "seg-7" }] } }
      ),
    ];
    const d = decorateAll(botMessageDecorations(opts), messages);
    show(d[1]!.after);
    fireEvent.click(
      await screen.findByRole("button", { name: "Good response" })
    );
    await waitFor(() =>
      expect(opts.sendFeedback).toHaveBeenCalledWith({
        sessionId: "s-1",
        segmentId: "seg-7",
        rating: "up",
        model: "m-1",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Good response" }));
    await waitFor(() =>
      expect(opts.sendFeedback).toHaveBeenLastCalledWith(
        expect.objectContaining({ rating: "clear" })
      )
    );
  });

  it("says when feedback could not be synced yet", async () => {
    const opts = options({
      sendFeedback: vi.fn(async () => ({ ok: false, reason: "not-synced" })),
    });
    const messages = [
      msg("u", "user", [text("hi")]),
      msg("a", "assistant", [text("Hello")]),
    ];
    const d = decorateAll(botMessageDecorations(opts), messages);
    show(d[1]!.after);
    fireEvent.click(
      await screen.findByRole("button", { name: "Bad response" })
    );
    await screen.findByText("Couldn't send feedback yet");
  });

  it("rates a live bubble by its last spoken text part, past thinking and tools", () => {
    expect(feedbackSegmentId(msg("live-1", "assistant", [text("Hi")]))).toBe(
      "live-1"
    );
    expect(
      feedbackSegmentId(
        msg("live-2", "assistant", [
          { type: "thinking", content: "plan" } as Part,
          ...tool("c9", "bash", { command: "ls" }),
          text("Done."),
          text("  "),
        ])
      )
    ).toBe("live-2#3");
    // A notice is not the reply.
    expect(
      feedbackSegmentId(
        msg("live-3", "assistant", [
          text("Answer"),
          {
            type: "text",
            content: "Limit reached",
            metadata: { abacus: { kind: "notification" } },
          } as Part,
        ])
      )
    ).toBe("live-3");
  });

  it("sends the text part's key for a bubble that opens with a tool call", async () => {
    const opts = options();
    const messages = [
      msg("u", "user", [text("hi")]),
      msg("a", "assistant", [
        ...tool("c4", "read", { file_path: "a.txt" }),
        text("It says hi."),
      ]),
    ];
    // The kit hands over the shown bubble, its tool parts dropped; the key
    // still counts the stored message's parts.
    const shown = msg("a", "assistant", [text("It says hi.")]);
    show(
      botMessageDecorations(opts)(shown, {
        messages,
        index: 1,
        runActive: false,
      })!.after
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Good response" })
    );
    await waitFor(() =>
      expect(opts.sendFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ segmentId: "a#2", rating: "up" })
      )
    );
  });

  it("offers no rating on a bubble with nothing rateable", () => {
    expect(feedbackSegmentId(msg("a", "assistant", tool("c", "ls", {})))).toBe(
      null
    );
    expect(feedbackSegmentId(msg("u", "user", [text("hi")]))).toBe(null);
    // Migrated text with no segment id cannot be found on the server.
    const orphan = msg("m", "assistant", [text("Old reply")], {
      abacus: { segments: [] },
    });
    expect(feedbackSegmentId(orphan)).toBe(null);
    const d = decorateAll(botMessageDecorations(options()), [
      msg("u", "user", [text("hi")]),
      orphan,
    ]);
    expect(d[1]?.after).toBeUndefined();
  });
});

describe("a bot-to-bot note", () => {
  const exchangeMessage = (): UIMessage =>
    ({
      id: "x1",
      role: "user",
      parts: [
        {
          type: "text",
          content:
            '[bot answer] Planner finished the task q8 ("Make a checklist") you passed it for the user. Its report:\n<bot_reply from="Planner">\nDone: 5 steps, saved as checklist.md.\n</bot_reply>\nTell the user what it did.',
        },
      ],
      metadata: {
        abacus: {
          userText: {
            systemReminder: true,
            operator: {
              kind: "bot-exchange",
              exchange: {
                askId: "q8",
                botId: "pla",
                bot: "Planner",
                kind: "task",
                request: "Make a checklist",
                outcome: "answered",
              },
            },
          },
        },
      },
    }) as unknown as UIMessage;

  it("is drawn as a row that opens to the other bot's words, and is not hidden", async () => {
    const decorate = botMessageDecorations({
      ...options(),
      bots: [],
    });
    const message = exchangeMessage();
    const context = { messages: [message], index: 0, runActive: false };
    expect(decorate.isMessageHidden(message, context)).toBe(false);
    const decoration = decorate(message, context);
    expect(decoration?.hidden).not.toBe(true);
    show(decoration?.before);
    expect(screen.getByText("Planner finished the task")).toBeTruthy();
    fireEvent.click(screen.getByText("Planner finished the task"));
    await waitFor(() =>
      expect(
        screen.getByText("Done: 5 steps, saved as checklist.md.")
      ).toBeTruthy()
    );
  });

  it("a turn that only asked another bot shows as 'Asked X: …' and is not dropped", () => {
    const decorate = botMessageDecorations({ ...options(), bots: [] });
    const message = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "t1",
          name: "give_task_to_bot",
          input: {
            bot: "Planner",
            task: "Make a 5-step opening-day checklist",
          },
        },
      ],
    } as unknown as UIMessage;
    const context = { messages: [message], index: 0, runActive: false };
    expect(decorate.isMessageHidden(message, context)).toBe(false);
    const decoration = decorate(message, context);
    show(decoration?.before);
    expect(
      screen.getByText(
        "Passed a task to Planner: Make a 5-step opening-day checklist"
      )
    ).toBeTruthy();
  });
});
