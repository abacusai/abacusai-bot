import type { UIMessage } from "@tanstack/ai-client";
import { expect, it } from "vitest";

import type { RunOutcomeRecord } from "@abacus-ai/contract/contract/ai-thread";
import type { GitChangeItem } from "@abacus-ai/contract/contracts";

import { lastRunChanges } from "./changes-card";
const message = (id: string, name: string, input: object) =>
  ({
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        id,
        name,
        input,
        arguments: JSON.stringify(input),
        state: "complete",
      },
    ],
  }) as UIMessage;
const outcome = (runId: string, afterMessageId: string) =>
  ({
    runId,
    afterMessageId,
    kind: "success",
    startedAt: 0,
    endedAt: 1,
    steps: 1,
  }) as RunOutcomeRecord;
const changes = ["old.txt", "new.txt", "second.txt", "untouched.txt"].map(
  (path) => ({ path, additions: 1, deletions: 0 }) as GitChangeItem
);
it("joins only the latest completed run's written paths to current checkout changes", () => {
  const messages = [
    message("a", "write", { path: "old.txt" }),
    message("b", "batch_edit", {
      edits: [
        { path: "/repo/new.txt" },
        { file_path: "second.txt" },
        { path: "/outside/no.txt" },
      ],
    }),
    message("c", "read", { path: "untouched.txt" }),
  ];
  expect(
    lastRunChanges(
      messages,
      [outcome("one", "a"), outcome("two", "c")],
      changes,
      "/repo"
    ).map((c) => c.path)
  ).toEqual(["new.txt", "second.txt"]);
  expect(
    lastRunChanges(
      messages,
      [outcome("one", "a"), outcome("two", "c")],
      changes.filter((c) => c.path === "old.txt"),
      "/repo"
    )
  ).toEqual([]);
});
it("does not attribute a paged-out boundary or a failed run", () => {
  const messages = [message("b", "write", { path: "new.txt" })];
  expect(
    lastRunChanges(
      messages,
      [outcome("one", "missing"), outcome("two", "b")],
      changes,
      "/repo"
    )
  ).toEqual([]);
  expect(
    lastRunChanges(
      messages,
      [{ ...outcome("two", "b"), kind: "error" }],
      changes,
      "/repo"
    )
  ).toEqual([]);
});
