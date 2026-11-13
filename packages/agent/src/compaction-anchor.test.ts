/**
 * A compaction keeps the open request word for word when it summarizes it out
 * of view, and a summarizer that returns nothing is replaced by a record of
 * what it was handed.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  ANCHOR_END,
  ANCHOR_START,
  anchorCompactions,
  anchoredSummary,
  isDegenerateSummary,
  mechanicalDigest,
  openRequest,
} from "./compaction-anchor.js";

const entry = (id: string, message: unknown): SessionEntry =>
  ({
    type: "message",
    id,
    parentId: null,
    timestamp: "",
    message,
  }) as unknown as SessionEntry;

const user = (id: string, text: string): SessionEntry =>
  entry(id, { role: "user", content: [{ type: "text", text }] });

const assistant = (
  id: string,
  text: string,
  calls: { name: string; args: unknown }[] = [],
  stopReason = calls.length > 0 ? "toolUse" : "stop"
): SessionEntry =>
  entry(id, {
    role: "assistant",
    stopReason,
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...calls.map((call, i) => ({
        type: "toolCall",
        id: `${id}-${i}`,
        name: call.name,
        arguments: call.args,
      })),
    ],
  });

const result = (id: string, toolName: string, text: string): SessionEntry =>
  entry(id, {
    role: "toolResult",
    toolName,
    content: [{ type: "text", text }],
  });

const compaction = (id: string, summary: string): SessionEntry =>
  ({
    type: "compaction",
    id,
    parentId: null,
    timestamp: "",
    summary,
    firstKeptEntryId: "",
    tokensBefore: 0,
  }) as unknown as SessionEntry;

const PROMPT = "Produce the weekday morning brief: calendar, Gmail, drafts.";

const branch = (): SessionEntry[] => [
  user("u1", PROMPT),
  assistant("a1", "Reading mail.", [
    { name: "abacus-connectors_Gmail_Tool", args: { action: "search" } },
  ]),
  result("r1", "abacus-connectors_Gmail_Tool", "x".repeat(20_000)),
  assistant("a2", "", [{ name: "current_time", args: {} }]),
  result("r2", "current_time", "2pm"),
  assistant("a3", "Still going.", [{ name: "current_time", args: {} }]),
];

const FIRST_RUN =
  '[first run] Introduce yourself once, then take the first step toward what the user asked: "hi".';
const ASK = "Make the menu blue and add my credits.";

/** A chat on its third request: the first two were answered, the third is mid-run. */
const longChat = (): SessionEntry[] => [
  user("u0", FIRST_RUN),
  assistant("a0", "Hi! I'm your assistant."),
  user("u1", "Build a mod called Larp Client."),
  assistant("a1", "", [{ name: "bash", args: { command: "gradle build" } }]),
  result("r1", "bash", "BUILD SUCCESSFUL"),
  assistant("a2", "Built it: larp-client.jar."),
  user("u2", ASK),
  assistant("a3", "Looking at the theme.", [
    { name: "bash", args: { command: "cat Client.java" } },
  ]),
  result("r3", "bash", "x".repeat(20_000)),
  assistant("a4", "", [{ name: "bash", args: { command: "cat Theme.java" } }]),
  result("r4", "bash", "class Theme {}"),
];

describe("the open request", () => {
  it("is the ask in progress when the summary takes it out of view, not the chat's first message", () => {
    expect(openRequest(longChat(), "a4")).toBe(ASK);
  });

  it("is null while the ask in progress is still kept word for word", () => {
    expect(openRequest(longChat(), "u2")).toBeNull();
    expect(openRequest(longChat(), "a3")).toBe(ASK);
  });

  it("is null when every compacted ask was answered", () => {
    expect(openRequest(longChat().slice(0, 6), "a2")).toBeNull();
  });

  it("keeps a stopped run's ask open alongside the message that followed it", () => {
    const stopped = [
      ...longChat(),
      assistant("a5", "", [], "aborted"),
      user("u3", "Also remove the Meteor credits."),
      assistant("a6", "", [{ name: "bash", args: { command: "ls" } }]),
    ];

    expect(openRequest(stopped, "a6")).toBe(
      `${ASK}\n\nAlso remove the Meteor credits.`
    );
  });

  it("is the first-run note itself while that first run is the one in progress", () => {
    const firstRun = [
      user("u0", FIRST_RUN),
      assistant("a0", "", [{ name: "memory", args: {} }]),
      result("r0", "memory", "ok"),
    ];

    expect(openRequest(firstRun, "r0")).toBe(FIRST_RUN);
  });

  it("is kept as head and tail when very long", () => {
    const long = `${"a".repeat(3_000)}${"b".repeat(3_000)}${"c".repeat(3_000)}`;
    const anchored = openRequest([user("u1", long)], "") ?? "";

    expect(anchored.length).toBeLessThan(4_100);
    expect(anchored.startsWith("aaa")).toBe(true);
    expect(anchored.endsWith("ccc")).toBe(true);
  });

  it("is null when nobody has asked anything", () => {
    expect(openRequest([assistant("a1", "hello")], "")).toBeNull();
  });
});

describe("a degenerate summary", () => {
  it("is headings, rules and whitespace with nothing under them", () => {
    expect(isDegenerateSummary("##")).toBe(true);
    expect(isDegenerateSummary("## Goal\n\n---\n\n## Progress\n")).toBe(true);
    expect(isDegenerateSummary("   ")).toBe(true);
  });

  it("is not a real summary, however short its headings", () => {
    expect(
      isDegenerateSummary(
        "## Goal\nProduce the morning brief.\n## Progress\nRead 12 threads, found two urgent replies and one deadline for Friday. Calendar has three meetings; the 3pm one needs the Q3 deck reviewed first."
      )
    ).toBe(false);
  });

  it("does not count the anchor as content", () => {
    expect(
      isDegenerateSummary(`${ANCHOR_START}\n${PROMPT}\n${ANCHOR_END}\n##`)
    ).toBe(true);
  });
});

describe("the mechanical digest", () => {
  it("records each compacted entry with tool results cut short", () => {
    const digest = mechanicalDigest(branch(), "a3");

    expect(digest).toContain(`User: ${PROMPT}`);
    expect(digest).toContain("→ abacus-connectors_Gmail_Tool(");
    expect(digest).toContain("← abacus-connectors_Gmail_Tool result: xxx");
    expect(digest).toContain("← current_time result: 2pm");
    // The kept entry and everything after it is not part of the digest.
    expect(digest).not.toContain("Still going.");
    expect(digest.length).toBeLessThan(2_000);
  });

  it("carries the previous summary forward", () => {
    const digest = mechanicalDigest(
      [compaction("c0", "Earlier: found three urgent threads."), ...branch()],
      "a3"
    );

    expect(digest).toContain(
      "## Earlier summary\nEarlier: found three urgent threads."
    );
  });
});

describe("the stored summary", () => {
  it("opens with the request verbatim, then the summarizer's text", () => {
    const stored = anchoredSummary(
      branch(),
      "## Progress\nRead the mail: two urgent replies pending, drafting them now. Calendar checked, three meetings today, nothing before noon needs prep.",
      "a3"
    );

    expect(stored.startsWith(ANCHOR_START)).toBe(true);
    expect(stored).toContain(PROMPT);
    expect(stored).toContain("two urgent replies pending");
  });

  it("pins the ask in progress, never a finished or dropped earlier one", () => {
    const stored = anchoredSummary(
      longChat(),
      "## Progress\nBuilt Larp Client earlier; now reading Client.java to find where the purple accent is set before changing it.",
      "a4"
    );

    expect(stored.startsWith(ANCHOR_START)).toBe(true);
    expect(stored).toContain(ASK);
    expect(stored.split(ANCHOR_END)[0]).not.toContain("first run");
    expect(stored.split(ANCHOR_END)[0]).not.toContain("Larp Client");
  });

  it("adds no anchor when the summary keeps the ask in progress in view", () => {
    const stored = anchoredSummary(
      longChat(),
      "## Progress\nBuilt Larp Client and handed over larp-client.jar; the user then asked for a new change.",
      "u2"
    );

    expect(stored).not.toContain(ANCHOR_START);
  });

  it("does not stack anchors when the summarizer echoed the last one", () => {
    const first = anchoredSummary(
      branch(),
      "Progress so far: read the mail and found two urgent replies.",
      "a3"
    );
    const second = anchoredSummary(
      branch(),
      `${first}\nMore progress: drafted both replies.`,
      "a3"
    );

    expect(second.split(ANCHOR_START)).toHaveLength(2);
    expect(second).toContain("drafted both replies");
  });

  it("replaces a summary that says nothing with the digest", () => {
    const stored = anchoredSummary(branch(), "##", "a3");

    expect(stored).toContain(PROMPT);
    expect(stored).toContain("mechanical record");
    expect(stored).toContain("← current_time result: 2pm");
  });
});

describe("anchorCompactions", () => {
  it("rewrites the summary on its way into the session", () => {
    const appendCompaction = vi.fn((..._args: unknown[]) => "c1");
    const manager = { getBranch: () => branch(), appendCompaction };

    anchorCompactions(manager as never);
    manager.appendCompaction("##", "a3", 123);

    const [summary, firstKept, tokensBefore] = appendCompaction.mock.calls[0]!;
    expect(String(summary)).toContain(PROMPT);
    expect(String(summary)).toContain("mechanical record");
    expect(firstKept).toBe("a3");
    expect(tokensBefore).toBe(123);
  });
});

describe("a chat that never ends", () => {
  it("pins no original request, drops an anchor an earlier build left, and keeps the digest guard", () => {
    const options = { anchorRequest: false };
    const old = anchoredSummary(
      branch(),
      "Progress so far: read the mail and found two urgent replies, one from the landlord about the lease " +
        "renewal and one from the dentist moving Thursday's appointment.",
      "a3"
    );
    const stored = anchoredSummary(branch(), old, "a3", options);

    expect(stored).not.toContain(ANCHOR_START);
    expect(stored).not.toContain("open request");
    expect(stored).toContain("two urgent replies");
    expect(anchoredSummary(branch(), "##", "a3", options)).toContain(
      "mechanical record"
    );
  });

  it("is what anchorCompactions stores when asked", () => {
    const appendCompaction = vi.fn((..._args: unknown[]) => "c1");
    const manager = { getBranch: () => branch(), appendCompaction };

    anchorCompactions(manager as never, { anchorRequest: false });
    manager.appendCompaction("Progress so far: drafted both replies.", "a3");

    expect(String(appendCompaction.mock.calls[0]![0])).not.toContain(
      ANCHOR_START
    );
  });
});
