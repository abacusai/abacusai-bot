/**
 * r2 #13: native ids at ingress never collide with the ids the v1 mapper
 * derives, across migrated and live history in one thread.
 */
import type { UIMessage } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import { fromNativeId, isPlainNativeId, toNativeId } from "./native-ids";
import { v1ToUiMessages } from "./v1-to-ui-messages";

const ids = (messages: readonly UIMessage[]): string[] =>
  messages.flatMap((message) => [
    message.id,
    ...message.parts.flatMap((part) => {
      if (part.type === "tool-call") return [part.id];
      if (part.type === "tool-result") return [part.id ?? ""];
      if (part.type === "subagent")
        return [part.subagent.id, ...ids(part.subagent.messages)];
      return [];
    }),
  ]);

describe("native id ingress (r2 #13)", () => {
  it("leaves ordinary ids alone and round-trips anything else", () => {
    for (const id of [
      "run-1:user",
      "toolu_01ABC",
      "call_x:result",
      "a:think:3",
    ])
      expect(toNativeId(id)).toBe(id);
    for (const id of ["a#2", "x%23", "%", "#", "a#b%c#"]) {
      expect(isPlainNativeId(id)).toBe(false);
      expect(toNativeId(id)).not.toContain("#");
      expect(fromNativeId(toNativeId(id))).toBe(id);
    }
    // Distinct inputs stay distinct.
    expect(toNativeId("a%23")).not.toBe(toNativeId("a#"));
  });

  it("keeps live ids disjoint from migrated ones", () => {
    // Migrated history with every kind of derived id.
    const migrated = v1ToUiMessages([
      { type: "text", id: "u", source: "user", content: "x" },
      { type: "text", id: "u", source: "user", content: "y" },
      { type: "subtask", id: "sub", status: "created" },
      { type: "text", id: "c", source: "bot", content: "z" },
      { type: "subtask", id: "sub", status: "completed" },
      {
        type: "tool_call",
        id: "t",
        toolCall: { id: "call", name: "read", args: {}, status: "rejected" },
      },
    ]);
    const derived = ids(migrated).filter((id) => id.includes("#"));
    expect(derived).toEqual(
      expect.arrayContaining(["u#2", "sub#0", "t#result"])
    );
    // A hostile or accidental live id spelled like each of them.
    for (const id of derived) expect(derived).not.toContain(toNativeId(id));
  });
});
