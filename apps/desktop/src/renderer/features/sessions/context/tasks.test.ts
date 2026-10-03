import { expect, it } from "vitest";

import { sessionTasks } from "./tasks";
it("uses the newest valid todo update and survives partial streamed arguments", () => {
  const messages = [
    {
      id: "m",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "old",
          name: "todo",
          arguments: JSON.stringify({
            todos: [{ content: "old", status: "pending" }],
          }),
        },
        {
          type: "tool-call",
          id: "new",
          name: "todo",
          arguments: JSON.stringify({
            todos: [
              { content: "done", status: "completed" },
              { content: 2, status: "pending" },
            ],
          }),
        },
        {
          type: "tool-call",
          id: "partial",
          name: "todo",
          arguments: '{"todos":',
        },
      ],
    },
  ] as never;
  expect(sessionTasks(messages)).toEqual([
    { content: "done", status: "completed" },
  ]);
});
