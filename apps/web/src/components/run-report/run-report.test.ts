import type { UIMessage } from "@tanstack/ai-client";
import { describe, expect, it } from "vitest";

import { reportAnchors } from "./index";

const message = (id: string, at: string): UIMessage =>
  ({
    id,
    role: "assistant",
    parts: [{ type: "text", content: id }],
    createdAt: new Date(at),
  }) as unknown as UIMessage;

const report = (at: string) => ({ at: new Date(at) });

describe("where a delivered report sits in the chat", () => {
  const messages = [
    message("a", "2026-11-04T08:00:00Z"),
    message("b", "2026-11-04T09:00:00Z"),
    message("hidden", "2026-11-04T09:30:00Z"),
    message("c", "2026-11-04T10:00:00Z"),
  ];
  const shown = (index: number) => messages[index]!.id !== "hidden";

  it("after the last shown message before it, in time order", () => {
    const early = report("2026-11-04T07:00:00Z");
    const between = report("2026-11-04T09:40:00Z");
    const late = report("2026-11-04T11:00:00Z");
    const anchors = reportAnchors(messages, [early, between, late], shown);
    expect(anchors.get(0)?.before).toEqual([early]);
    // Not on the hidden message, which draws nothing.
    expect(anchors.get(1)?.after).toEqual([between]);
    expect(anchors.has(2)).toBe(false);
    expect(anchors.get(3)?.after).toEqual([late]);
  });

  it("nowhere in a chat with nothing shown", () => {
    expect(
      reportAnchors([], [report("2026-11-04T07:00:00Z")], () => true).size
    ).toBe(0);
  });
});
