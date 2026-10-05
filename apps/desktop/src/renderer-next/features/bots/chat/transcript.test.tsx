import type { UIMessage } from "@tanstack/ai-client";
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FakeRelay } from "#next/features/chat/fixtures/relay";
import { renderRelay } from "#next/features/chat/testing";
import { botVisibleMessage } from "#next/lib/bot-turns/turns";

let current: Awaited<ReturnType<typeof renderRelay>> | undefined;
afterEach(async () => {
  await current?.cleanup();
  current = undefined;
});
const reply = (parts: UIMessage["parts"]): UIMessage => ({
  id: "a",
  role: "assistant",
  parts,
});
describe("bot transcript whitelist", () => {
  it("renders visible prose while withholding reasoning, migrated search and step history", async () => {
    const message = reply([
      { type: "text", content: "Here is the report" },
      { type: "thinking", content: "private reasoning" } as never,
      {
        type: "text",
        content: "search internals",
        metadata: { abacus: { kind: "search_result" } },
      } as never,
      {
        type: "tool-call",
        id: "tool",
        name: "read",
        arguments: "{}",
        state: "complete",
      } as never,
    ]);
    current = await renderRelay(new FakeRelay({ history: [message] }), "bot");
    await screen.findByText("Here is the report");
    expect(screen.queryByText("private reasoning")).toBeNull();
    expect(screen.queryByText("search internals")).toBeNull();
    expect(screen.queryByText(/Worked through/)).toBeNull();
  });
  it.each([false, true])(
    "filters duplicate emoji in mixed %s messages and holds a trailing live emoji part",
    (migrated) => {
      const tools = reply([
        {
          type: "tool-call",
          id: "reaction",
          name: "react_to_message",
          arguments: '{"emoji":"👍"}',
          input: { emoji: "👍" },
          state: "complete",
        } as never,
        {
          type: "tool-result",
          toolCallId: "reaction",
          content: '{"text":"{\\"emoji\\":\\"👍\\"}","rejected":false}',
          state: "complete",
        } as never,
      ]);
      tools.id = "tool";
      const message = reply([
        { type: "text", content: "👍" },
        { type: "text", content: "Here is the report" },
      ]);
      if (migrated) message.metadata = { abacus: { segmentId: "legacy" } };
      expect(botVisibleMessage(message, [tools, message], false).parts).toEqual(
        [{ type: "text", content: "Here is the report" }]
      );
      const live = reply([
        { type: "text", content: "Here is the report" },
        { type: "text", content: "👍" },
      ]);
      expect(botVisibleMessage(live, [live], true).parts).toEqual([
        { type: "text", content: "Here is the report" },
      ]);
    }
  );
});
