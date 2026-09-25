/**
 * A bot's chat as a message thread.
 *
 * The claim worth pinning is the split: hiding tool calls is not just hiding
 * them, it is what turns one long turn into the short messages a person would
 * have sent. If the prose either side of a tool call collapsed back into one
 * bubble, the feature would look like it worked while losing the thing it was
 * for.
 */
import { render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatRenderItem } from "./render-utils";

vi.mock("../common/markdown", () => ({
  Markdown: ({ content }: { content: string }) => <p>{content}</p>,
}));

vi.mock("../../hooks/use-workspace-root", () => ({
  useResolveWorkspacePath: () => (path: string) => path,
  useWorkspaceRoot: () => "/workspace",
}));

const { BotMessageList } = await import("./bot-message-list");

const text = (id: string, content: string) =>
  ({ kind: "text", id, content, streaming: false }) as const;

const toolGroup = (id: string) =>
  ({
    kind: "tool_group",
    id,
    tools: [],
    summary: "Read 3 files",
    state: "done",
  }) as never;

const bubbles = (): string[] =>
  [...document.querySelectorAll('[data-id="bot-message-list"] p')].map(
    (node) => node.textContent ?? ""
  );

describe("a bot's thread", () => {
  it("splits a turn into a bubble either side of the work", () => {
    const items: ChatRenderItem[] = [
      { kind: "user", id: "u1", text: "what's in this folder?" },
      {
        kind: "agent",
        id: "a1",
        items: [
          text("t1", "On it, let me look."),
          toolGroup("g1"),
          text("t2", "Four folders and a stray zip."),
        ],
      },
    ];

    render((<BotMessageList chatItems={items} />) as JSX.Element);

    expect(bubbles()).toEqual([
      "On it, let me look.",
      "Four folders and a stray zip.",
    ]);
  });

  it("shows no trace of the tools themselves", () => {
    const items: ChatRenderItem[] = [
      {
        kind: "agent",
        id: "a1",
        items: [toolGroup("g1"), text("t1", "Done.")],
      },
    ];

    render((<BotMessageList chatItems={items} />) as JSX.Element);

    expect(screen.queryByText("Read 3 files")).toBeNull();
    expect(bubbles()).toEqual(["Done."]);
  });

  it("drops a turn that only did work and said nothing", () => {
    // An empty bubble reads as a message that failed to load, which is worse
    // than the turn not appearing until the bot has something to say.
    const items: ChatRenderItem[] = [
      { kind: "agent", id: "a1", items: [toolGroup("g1")] },
      { kind: "agent", id: "a2", items: [text("t1", "  ")] },
    ];

    render((<BotMessageList chatItems={items} />) as JSX.Element);

    expect(
      document.querySelectorAll('[data-id^="bot-message-agent-"]')
    ).toHaveLength(0);
  });

  it("shows the files a turn made, even when the tools that made them are hidden", () => {
    // The doc a bot wrote used to vanish with the tool log: a bubble saying
    // "done" and nothing to click. The card is the one trace of the work kept.
    const wrote = {
      kind: "tool_group",
      id: "g1",
      summary: "Wrote 1 file",
      state: "done",
      tools: [
        {
          id: "w1",
          name: "write",
          input: { file_path: "/w/report.docx" },
          result: { id: "r1", content: "" },
          state: "done",
          streamingArgs: false,
        },
      ],
    } as never;
    const items: ChatRenderItem[] = [
      { kind: "agent", id: "a1", items: [wrote, text("t1", "Here you go.")] },
      { kind: "agent", id: "a2", items: [wrote] },
    ];

    render((<BotMessageList chatItems={items} />) as JSX.Element);

    expect(screen.queryByText("Wrote 1 file")).toBeNull();
    expect(bubbles()).toEqual(["Here you go."]);
    // Both turns keep their card; the second said nothing but still delivered.
    expect(
      document.querySelectorAll('[data-id="deliverables-card"]')
    ).toHaveLength(2);
    expect(screen.getAllByText("report.docx")).toHaveLength(2);
  });

  it("keeps what the bot reported, so a stuck bot is not a silent one", () => {
    const items: ChatRenderItem[] = [
      {
        kind: "agent",
        id: "a1",
        items: [
          {
            kind: "notification",
            id: "n1",
            message: "Telegram needs a sign-in first.",
            severity: "warning",
          } as never,
        ],
      },
    ];

    render((<BotMessageList chatItems={items} />) as JSX.Element);

    expect(screen.getByText("Telegram needs a sign-in first.")).toBeTruthy();
  });

  it("puts the user on the other side", () => {
    const items: ChatRenderItem[] = [{ kind: "user", id: "u1", text: "hi" }];

    render((<BotMessageList chatItems={items} />) as JSX.Element);

    expect(
      document.querySelector('[data-id="bot-message-user-u1"]')
    ).toBeTruthy();
  });
});

describe("when the thread says the time", () => {
  const MINUTE = 60 * 1000;
  const now = new Date("2026-08-27T14:00:00").getTime();

  // The component reads the clock itself (`Date.now()`), and these stamps are
  // written relative to the fixed `now` above, so without pinning it what
  // "yesterday" renders as depends on the day the suite runs. This passed for
  // exactly one day, 2026-08-27, and named a weekday from the 28th on.
  //
  // Only Date is faked. Faking the timers too would take React's scheduler
  // with it, and nothing here is waiting on one.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const thread = (stamps: number[]): ChatRenderItem[] =>
    stamps.map((_, index) => ({
      kind: "user" as const,
      id: `u${index}`,
      text: `message ${index}`,
    }));

  const times = (stamps: number[]): Map<string, number> =>
    new Map(stamps.map((at, index) => [`u${index}`, at]));

  const stamps = (): string[] =>
    [...document.querySelectorAll('[data-id^="bot-message-stamp-"]')].map(
      (node) => node.textContent ?? ""
    );

  it("stamps the first message and then only after a quiet stretch", () => {
    // Two messages a minute apart are one conversation; stamping between them
    // would break a single exchange into pieces that were never separate.
    const at = [now - 90 * MINUTE, now - 89 * MINUTE, now - 5 * MINUTE];

    render(
      (
        <BotMessageList chatItems={thread(at)} times={times(at)} />
      ) as JSX.Element
    );

    expect(stamps()).toHaveLength(2);
  });

  it("says nothing at all when it does not know the time", () => {
    // A transcript written before times were recorded. Guessing would be worse
    // than the silence: a wrong "Yesterday" is a lie about when work happened.
    render((<BotMessageList chatItems={thread([0, 0])} />) as JSX.Element);

    expect(stamps()).toHaveLength(0);
  });

  it("names the day only once it is not today", () => {
    const at = [now - 26 * 60 * MINUTE, now - 30 * MINUTE];

    render(
      (
        <BotMessageList chatItems={thread(at)} times={times(at)} />
      ) as JSX.Element
    );

    const [older, newer] = stamps();
    expect(older).toContain("Yesterday");
    expect(newer).not.toContain("Yesterday");
  });
});

describe("while the bot is off doing something", () => {
  it("keeps the dots up until the turn ends", () => {
    // The thread hides tool calls, so without this a bot reading half your
    // home directory looks exactly like one that stopped replying.
    const items: ChatRenderItem[] = [
      { kind: "user", id: "u1", text: "have a look" },
    ];

    const { rerender } = render(
      (<BotMessageList chatItems={items} isWorking />) as JSX.Element
    );
    expect(
      document.querySelector('[data-id="bot-message-working"]')
    ).toBeTruthy();

    rerender((<BotMessageList chatItems={items} />) as JSX.Element);
    expect(
      document.querySelector('[data-id="bot-message-working"]')
    ).toBeNull();
  });
});

describe("a failed turn that offers a different model", () => {
  it("puts a Switch model button on the notice, wired to the panel", () => {
    const onSwitchModel = vi.fn();
    const items: ChatRenderItem[] = [
      {
        kind: "agent",
        id: "a1",
        items: [
          {
            kind: "notification",
            id: "n1",
            severity: "error",
            message: "The model provider did not respond (400).",
            actions: [{ type: "switch-model" }],
          } as never,
        ],
      },
    ];

    render(
      (
        <BotMessageList chatItems={items} onSwitchModel={onSwitchModel} />
      ) as JSX.Element
    );

    const button = document.querySelector<HTMLButtonElement>(
      '[data-id="notification-switch-model-btn"]'
    );
    expect(button).not.toBeNull();
    button!.click();
    expect(onSwitchModel).toHaveBeenCalled();
  });
});
