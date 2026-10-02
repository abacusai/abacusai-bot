/**
 * R3-T19 (decorations): what the bot skin's `decorateMessage` returns per
 * message: silent turns hidden, the reaction badge and the dropped emoji
 * reply, one deliverables card whose rows open through the route's
 * callbacks, and feedback only with an Abacus account, never on the live
 * run, `clear` on a re-click, keyed by the migrated segment id.
 */
import type { UIMessage } from "@tanstack/ai-client";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import * as turns from "#next/lib/bot-turns/turns";
import { i18n, initI18n } from "#next/lib/i18n";

import {
  botMessageDecorations,
  feedbackSegmentId,
  type BotDecorationOptions,
} from "./decorations";

vi.mock("#next/lib/bot-turns/turns", async (importOriginal) => {
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
      msg("a", "assistant", [text("Hello")], {
        abacus: { segmentId: "seg-7" },
      }),
    ];
    const d = decorateAll(botMessageDecorations(opts), messages);
    show(d[1]!.after);
    fireEvent.click(screen.getByRole("button", { name: "Rate this reply" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Rate this reply" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Bad response" })
    );
    await screen.findByText("Couldn't send feedback yet");
  });

  it("a live message is rated by its id", () => {
    expect(feedbackSegmentId(msg("live-1", "assistant", []))).toBe("live-1");
  });
});
