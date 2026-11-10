/**
 * The hand-off summary reads the branch on the summarizer it is given, lists
 * the files touched, quotes the last failing tool result word for word, and
 * falls back to the mechanical record when the summarizer writes nothing.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import type { Summarizer } from "./extensions/spend-governor.js";
import {
  HANDOFF_FOCUS,
  handoffSummary,
  lastToolError,
} from "./handoff-summary.js";

const entry = (id: string, message: unknown): SessionEntry =>
  ({
    type: "message",
    id,
    parentId: null,
    timestamp: "",
    message,
  }) as unknown as SessionEntry;

const user = (id: string, text: string) =>
  entry(id, { role: "user", content: [{ type: "text", text }] });

const assistant = (
  id: string,
  text: string,
  call?: { id: string; name: string; args: unknown }
) =>
  entry(id, {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...(call
        ? [
            {
              type: "toolCall",
              id: call.id,
              name: call.name,
              arguments: call.args,
            },
          ]
        : []),
    ],
  });

const result = (id: string, tool: string, text: string, isError = false) =>
  entry(id, {
    role: "toolResult",
    toolCallId: `${id}-call`,
    toolName: tool,
    isError,
    content: [{ type: "text", text }],
  });

const STUCK: SessionEntry[] = [
  user("u1", "Fix the login crash"),
  assistant("a1", "", {
    id: "c1",
    name: "edit",
    args: { path: "/repo/src/login.js", oldText: "a", newText: "b" },
  }),
  result("r1", "edit", "Edited /repo/src/login.js"),
  assistant("a2", "", {
    id: "c2",
    name: "bash",
    args: { command: "npm test" },
  }),
  result(
    "r2",
    "bash",
    "TypeError: Cannot read properties of undefined (reading 'token')\n    at login (src/login.js:12:9)",
    true
  ),
  assistant("a3", "I changed how the session is read."),
  user("u2", "It still doesn't work, same error"),
  assistant("a4", "I looked again and adjusted the guard."),
];

/** A summarizer that answers `text` and keeps what it was asked. */
const fake = (text: string) => {
  const asked: { system: string; prompt: string; model: string }[] = [];
  const summarizer: Summarizer = {
    model: {
      provider: "abacus",
      id: "cheap",
      contextWindow: 200_000,
      maxTokens: 8_000,
    } as never,
    streamFn: ((model: { id: string }, context: never) => {
      const { systemPrompt, messages } = context as {
        systemPrompt: string;
        messages: { content: { text: string }[] }[];
      };
      asked.push({
        system: systemPrompt,
        prompt: messages[0]!.content[0]!.text,
        model: model.id,
      });
      return {
        result: async () => ({
          role: "assistant",
          content: [{ type: "text", text }],
          stopReason: "stop",
          usage: { input: 0, output: 0 },
        }),
      };
    }) as never,
  };
  return { summarizer, asked };
};

const SUMMARY = [
  "## Goal",
  "Fix the crash on the login page when the session has no token.",
  "## Progress",
  "### Blocked",
  "- Guarding the session read in src/login.js did not help: the token is read before the guard.",
  "## Next Steps",
  "1. Read the token after the session check.",
].join("\n");

describe("handoffSummary", () => {
  it("summarizes the branch on the summarizer it gets, with the files and the last error word for word", async () => {
    const { summarizer, asked } = fake(SUMMARY);
    const tokens: number[] = [];
    const text = await handoffSummary(STUCK, async (count) => {
      tokens.push(count);
      return summarizer;
    });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toBeGreaterThan(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.model).toBe("cheap");
    expect(asked[0]!.prompt).toContain("Fix the login crash");
    expect(asked[0]!.prompt).toContain(HANDOFF_FOCUS);
    // pi's preamble about returning to a branch is not ours to say.
    expect(text).not.toContain("explored a different conversation branch");
    expect(text!.startsWith("## Goal")).toBe(true);
    expect(text).toContain("<modified-files>\n/repo/src/login.js");
    expect(text).toContain(
      "## Last error (bash, verbatim)\n```\nTypeError: Cannot read properties of undefined (reading 'token')\n    at login (src/login.js:12:9)\n```"
    );
  });

  it("leaves the mechanical record when the summarizer writes nothing usable", async () => {
    const { summarizer } = fake("## Goal\n");
    const text = await handoffSummary(STUCK, async () => summarizer);
    expect(text).toContain("mechanical record");
    expect(text).toContain("User: Fix the login crash");
    expect(text).toContain("## Last error (bash, verbatim)");
  });

  it("writes nothing when no model may summarize for this chat", async () => {
    expect(await handoffSummary(STUCK, async () => null)).toBeNull();
  });

  it("throws when the summarizer fails, so the caller says so", async () => {
    const { summarizer } = fake("");
    summarizer.streamFn = (() => ({
      result: async () => ({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "upstream refused",
        usage: { input: 0, output: 0 },
      }),
    })) as never;
    await expect(handoffSummary(STUCK, async () => summarizer)).rejects.toThrow(
      /upstream refused/
    );
  });
});

describe("lastToolError", () => {
  it("finds the newest failing result in the last two user turns", () => {
    expect(lastToolError(STUCK)?.tool).toBe("bash");
  });

  it("ignores one older than that, and successes", () => {
    expect(
      lastToolError([
        ...STUCK,
        user("u3", "Now the footer"),
        assistant("a5", "Done."),
        user("u4", "And the header"),
        assistant("a6", "", {
          id: "c9",
          name: "bash",
          args: { command: "ls" },
        }),
        result("r9", "bash", "src"),
      ])
    ).toBeNull();
  });

  it("quotes a long error up to its cap", () => {
    const long = "x".repeat(2_000);
    const found = lastToolError([
      user("u1", "Run it"),
      result("r1", "bash", long, true),
    ]);
    expect(found!.text.startsWith("x".repeat(1_200))).toBe(true);
    expect(found!.text).toContain("[… 800 more characters]");
  });
});
