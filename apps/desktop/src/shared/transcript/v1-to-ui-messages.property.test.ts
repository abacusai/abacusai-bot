/**
 * C-T2: mapper properties over the C-T1 fixtures plus 200 generated
 * transcripts (seeded, so a failure reproduces):
 * - every input segment appears exactly once in some provenance list;
 * - every part-producing segment's id is on its part (the C.3 placement
 *   table);
 * - the output parses with the valibot `ThreadFileV2` schema;
 * - no tool-result has an `outcome` with a `state` other than `error`;
 * - converting twice, or after a JSON round trip, gives identical output;
 * - message ids are unique within a thread.
 */
import fs from "node:fs";
import path from "node:path";

import type { MessagePart, UIMessage } from "@tanstack/ai";
import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { inputSegmentIds, provenance } from "./test-support";
import {
  parseTranscriptV1,
  ThreadFileV2Schema,
  v1ToThreadFile,
} from "./thread-file";

const FIXTURES = path.join(__dirname, "__fixtures__", "v1");

/** mulberry32: small, seeded, good enough for shapes. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const STATUSES = [
  "success",
  "error",
  "rejected",
  "interrupted",
  "skipped",
  "abandoned",
  "pending",
  "executing",
  "awaiting_permission",
  undefined,
];
const REJECTIONS = [undefined, "rejected", "interrupted", "sibling_failed"];

const generate = (seed: number): unknown[] => {
  const random = rng(seed);
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(random() * list.length)] as T;
  let counter = 0;
  const id = (prefix: string) =>
    // Now and then a repeated or missing id, as corrupt files have.
    random() < 0.03 ? "dup" : `${prefix}-${seed}-${counter++}`;
  const at = () =>
    random() < 0.2 ? undefined : 1_788_256_800_000 + counter * 1000;
  let messageIndex = 0;

  const tool = (): Record<string, unknown> => {
    const callId = id("call");
    const status = pick(STATUSES);
    const withResult = random() < 0.6;
    const rejection = pick(REJECTIONS);
    return {
      type: "tool_call",
      id: id("tool"),
      at: at(),
      toolCall: {
        id: callId,
        name: pick(["bash", "read", "edit", "write", "mcp__x__y", "odd"]),
        args: { n: counter },
        ...(status === undefined ? {} : { status }),
      },
      ...(withResult
        ? {
            toolResult: {
              toolCallId: callId,
              output: `out ${counter}`,
              ...(random() < 0.2 ? { error: "boom" } : {}),
              ...(rejection === undefined
                ? {}
                : { rejection: { reason: rejection } }),
              ...(random() < 0.3
                ? { data: { type: "generic", output: "x" } }
                : {}),
            },
          }
        : {}),
    };
  };

  const simple = (): unknown => {
    switch (Math.floor(random() * 14)) {
      case 0:
        return {
          type: "text",
          id: id("user"),
          source: "user",
          content: "hi",
          at: at(),
          ...(random() < 0.5 ? { messageIndex: messageIndex++ } : {}),
        };
      case 1:
        return {
          type: "text",
          id: id("bot"),
          source: "bot",
          content: "hello",
          at: at(),
          ...(random() < 0.4 ? { messageIndex: messageIndex++ } : {}),
          ...(random() < 0.2 ? { regenerateAttempt: 1 } : {}),
        };
      case 2:
        return { type: "thinking", id: id("think"), content: "hmm", at: at() };
      case 3:
        return tool();
      case 4:
        return {
          type: "tool_group",
          id: id("group"),
          category: "read",
          summary: "s",
          tools: Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
            random() < 0.9 ? tool() : simple()
          ),
        };
      case 5:
        return {
          type: "subtask",
          id: id("sub"),
          status: "created",
          at: at(),
          ...(random() < 0.5 ? { kind: pick(["browser", "component"]) } : {}),
        };
      case 6:
        return {
          type: "subtask",
          id: id("sub"),
          status: "completed",
          at: at(),
          ...(random() < 0.6
            ? { outcome: pick(["completed", "interrupted"]) }
            : {}),
        };
      case 7:
        return { type: "credits", id: id("credits"), creditsUsed: 2 };
      case 8:
        return {
          type: "notification",
          id: id("note"),
          message: "m",
          severity: "info",
        };
      case 9:
        return {
          type: "media",
          id: id("media"),
          media: {
            kind: pick(["image", "video", "audio"]),
            url: "https://example.com/m",
            width: 1,
            height: 1,
            loop: false,
          },
        };
      case 10:
        return { type: "compaction", id: id("compact"), summary: "s" };
      case 11:
        return {
          type: "web_search_results",
          id: id("search"),
          query: "q",
          resultType: "web",
          results: [],
        };
      case 12:
        return pick([
          { type: "mystery", id: id("x") },
          null,
          7,
          { type: "text", source: "bot", content: 1 },
        ]);
      default:
        return {
          type: "collapsible",
          id: id("fold"),
          content: "c",
          title: "t",
        };
    }
  };

  return Array.from({ length: Math.floor(random() * 40) }, simple);
};

const fixtureInputs = (): Array<[string, unknown[]]> =>
  fs
    .readdirSync(FIXTURES)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const parsed = parseTranscriptV1(
        fs.readFileSync(path.join(FIXTURES, name), "utf8")
      );
      if (parsed.status !== "ok") throw new Error(name);
      return [name, parsed.file.segments];
    });

const CASES: Array<[string, unknown[]]> = [
  ...fixtureInputs(),
  ...Array.from({ length: 200 }, (_, seed): [string, unknown[]] => [
    `generated #${seed}`,
    generate(seed),
  ]),
];

const convert = (segments: readonly unknown[]) =>
  v1ToThreadFile({
    threadId: "t",
    updatedAt: "2026-09-01T00:00:00.000Z",
    segments,
  });

/** Where C.3 puts the segment id on a part. */
const partCarries = (
  message: UIMessage,
  index: number,
  segmentId: string
): boolean => {
  const part = message.parts[index] as MessagePart | undefined;
  if (part === undefined) return false;
  const tagged = (metadata: unknown) =>
    (metadata as { abacus?: { segmentId?: string } } | undefined)?.abacus
      ?.segmentId === segmentId;
  switch (part.type) {
    case "text":
    case "image":
    case "video":
      return tagged(part.metadata);
    case "tool-call": {
      const next = message.parts[index + 1];
      const resultOk =
        next?.type !== "tool-result" ||
        next.toolCallId !== part.id ||
        next.id === `${segmentId}:result`;
      return tagged(part.metadata) && resultOk;
    }
    case "thinking":
      return part.stepId === segmentId;
    case "subagent":
      return part.subagent.id === segmentId;
    default:
      return false;
  }
};

const allMessages = (messages: readonly UIMessage[]): UIMessage[] =>
  messages.flatMap((message) => [
    message,
    ...allMessages(
      message.parts.flatMap((part) =>
        part.type === "subagent" ? part.subagent.messages : []
      )
    ),
  ]);

describe("C-T2 mapper properties", () => {
  it.each(CASES)("%s", (_name, segments) => {
    const file = convert(segments);
    const hits = provenance(file.messages);

    // Every input segment exactly once (a multiset: brackets share ids).
    expect(hits.map((hit) => hit.entry.id).sort()).toEqual(
      inputSegmentIds(segments).sort()
    );

    // Each part-producing segment's id is on its part.
    for (const { entry, message } of hits) {
      if (entry.partIndex === null) continue;
      expect(message).not.toBeNull();
      expect({
        id: entry.id,
        ok: partCarries(message as UIMessage, entry.partIndex, entry.id),
      }).toEqual({ id: entry.id, ok: true });
    }

    // The schema.
    const parsed = v.safeParse(ThreadFileV2Schema, file);
    expect(parsed.issues?.map((issue) => issue.message) ?? []).toEqual([]);

    // Outcome implies error; ids unique.
    const everyMessage = allMessages(file.messages);
    for (const message of everyMessage)
      for (const part of message.parts)
        if (part.type === "tool-result" && part.outcome !== undefined)
          expect(part.state).toBe("error");
    const ids = everyMessage.map((message) => message.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Deterministic, and stable across a JSON round trip of the input.
    const again = convert(JSON.parse(JSON.stringify(segments)) as unknown[]);
    expect(JSON.stringify(again)).toBe(JSON.stringify(file));
  });
});
