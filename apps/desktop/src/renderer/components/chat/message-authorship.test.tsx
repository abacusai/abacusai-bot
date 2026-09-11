/**
 * Neither side of a chat is labelled, in a session as in a bot's chat.
 *
 * A thread between two parties does not need to name them on every message:
 * the side of the screen already says who spoke. No message app labels your
 * own messages with your initial, or repeats the other party's name and mark
 * above every reply. Bots dropped both first; a session is the same two
 * parties talking, so it reads the same way.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../common/markdown", () => ({
  Markdown: ({ content }: { content: string }) => <p>{content}</p>,
}));

const { ChatMessageList, UserMessageBubble } = await import("./agent-message");
const { BotMessageList } = await import("./bot-message-list");
const { BUBBLE_MAX_WIDTH } = await import("./bubble-width");

describe("a message the user sent", () => {
  it("carries no avatar and no initial", () => {
    render((<UserMessageBubble content="ship it" />) as JSX.Element);

    expect(screen.getByText("ship it")).toBeTruthy();
    expect(
      document.querySelector('[data-id="user-message-avatar"]')
    ).toBeNull();
  });

  it("does not take an account read to render", () => {
    // The avatar was the only thing here that needed the signed-in account, so
    // this renders with no account store and no Abacus query mocked at all —
    // which is the point: a bubble is text and a side of the screen.
    expect(() =>
      render((<UserMessageBubble content="still fine" />) as JSX.Element)
    ).not.toThrow();
  });
});

describe("the agent's reply", () => {
  it("is not signed with a mark and a name on every turn", () => {
    render(
      (
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: { queries: { retry: false } },
            })
          }
        >
          <ChatMessageList
            chatItems={[
              {
                kind: "agent",
                id: "a1",
                items: [
                  {
                    kind: "text",
                    id: "t1",
                    content: "done",
                    streaming: false,
                  },
                ],
              },
            ]}
            isPending={false}
          />
        </QueryClientProvider>
      ) as JSX.Element
    );

    expect(screen.getByText("done")).toBeTruthy();
    expect(
      document.querySelector('[data-id="agent-message-author"]')
    ).toBeNull();
    expect(screen.queryByText("AbacusAI Bot")).toBeNull();
  });
});

/**
 * Both voices stop at the same place.
 *
 * The bot bubbles were capped at `32rem`, which on any wide window bound
 * before the percentage did: a bubble ended just past the middle with a band
 * of empty pane beside it, and the text wrapped early enough to look cut off.
 * The session's own bubbles were capped somewhere else again. One rule now,
 * so the two sides cannot drift apart.
 */
describe("how wide a bubble gets", () => {
  const widthOf = (node: Element | null): string[] =>
    (node?.className ?? "")
      .split(/\s+/)
      .filter((name) => name.startsWith("max-w-"));

  it("is the same rule for what the user said and what the bot said", () => {
    render(
      (
        <BotMessageList
          chatItems={[
            { kind: "user", id: "u1", text: "hello" },
            {
              kind: "agent",
              id: "a1",
              items: [
                { kind: "text", id: "t1", content: "hi", streaming: false },
              ],
            },
          ]}
        />
      ) as JSX.Element
    );

    const [user, bot] = [
      document.querySelector('[data-id="bot-message-user-u1"]'),
      [...document.querySelectorAll('[data-id="bot-message-list"] p')][0]
        ?.parentElement,
    ];

    expect(widthOf(user)).toEqual([BUBBLE_MAX_WIDTH]);
    expect(widthOf(bot ?? null)).toEqual([BUBBLE_MAX_WIDTH]);
  });

  it("is the same rule in a session as in a bot's chat", () => {
    render((<UserMessageBubble content="hello" />) as JSX.Element);

    expect(widthOf(document.querySelector('[class*="bg-primary/15"]'))).toEqual(
      [BUBBLE_MAX_WIDTH]
    );
  });

  it("still leaves the far side of the pane open", () => {
    // A bubble allowed the full width would put both voices on the same
    // column, and the side of the screen is the only thing saying who spoke
    // now that neither is labelled.
    expect(BUBBLE_MAX_WIDTH).toMatch(/%\)\]$/);
  });
});
