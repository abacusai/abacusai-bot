import type { UIMessage } from "@tanstack/ai-client";
import { expect, it } from "vitest";

import { resumeCardChips, resumeCardShown } from "./resume-card";

const call = (input: unknown, name = "agent-tools_suggest_tasks") => ({
  type: "tool-call" as const,
  id: `c${Math.random()}`,
  name,
  arguments: JSON.stringify(input),
  state: "complete" as const,
});
const reply = (...parts: unknown[]): UIMessage =>
  ({ id: "m", role: "assistant", parts }) as UIMessage;
const user: UIMessage = {
  id: "u",
  role: "user",
  parts: [{ type: "text", content: "Build my site" }],
} as UIMessage;

it("offers the latest result's next steps, at most three, none to copy", () => {
  const messages = [
    user,
    reply(call({ after_result: true, tasks: [{ text: "Old step" }] })),
    reply(
      { type: "text", content: "Your site is ready. Add your menu?" },
      call({
        after_result: true,
        tasks: [
          { text: "Add my menu" },
          { text: "Send it to my phone", copy: true },
          { text: "Check reviews weekly", routine: true },
        ],
      })
    ),
  ];
  expect(resumeCardChips(messages)).toEqual([
    "Add my menu",
    "Check reviews weekly",
  ]);
  const four = ["One", "Two", "Three", "Four"].map((text) => ({ text }));
  expect(
    resumeCardChips([reply(call({ after_result: true, tasks: four }))])
  ).toEqual(["One", "Two", "Three"]);
});

it("offers nothing when the result ended without a next step", () => {
  expect(
    resumeCardChips([
      user,
      reply(call({ tasks: [{ text: "A menu, not a next step" }] })),
      reply(call({ after_result: true, tasks: [] }, "write")),
    ])
  ).toEqual([]);
});

const DAY = 24 * 60 * 60 * 1000;
const mark = { sessionId: "s", resultAt: 0, wroteAt: 0, closedAt: null };
const chat = { routineId: null, editorFor: null };

it.each<[string, Parameters<typeof resumeCardShown>, boolean]>([
  ["a day after the result", [mark, chat, DAY], true],
  ["the same evening", [mark, chat, 8 * 60 * 60 * 1000], false],
  ["after a message since", [{ ...mark, wroteAt: DAY / 2 }, chat, DAY], false],
  ["once closed", [{ ...mark, closedAt: 1 }, chat, DAY], false],
  ["for a chat that is gone", [mark, undefined, DAY], false],
  ["for a routine's run", [mark, { ...chat, routineId: "r" }, DAY], false],
  ["with no result", [null, chat, DAY], false],
])("the card %s: shown %s", (_case, args, shown) => {
  expect(resumeCardShown(...args) != null).toBe(shown);
});
