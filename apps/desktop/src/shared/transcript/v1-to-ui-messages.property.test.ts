/**
 * C-T2: mapper properties over the C-T1 fixtures plus 200 generated
 * transcripts (seeded, so a failure reproduces):
 * - every input segment appears exactly once in some provenance list;
 * - every part-producing segment's id is on its part (the C.3 placement
 *   table), and each tool call is followed by its own result;
 * - only malformed input maps to `unknown`, and a well-formed segment's part
 *   holds its content (text, query, summary, URL, tool name, args, output,
 *   legacy data after the storage dedupe);
 * - the output parses with the strict migrated-thread schema;
 * - no tool-result has an `outcome` with a `state` other than `error`;
 * - converting twice, or after a JSON round trip, gives identical output;
 * - message, tool call, result and sub-agent ids are unique within a thread,
 *   every call has exactly one result, and no call stores an output.
 */
import fs from "node:fs";
import path from "node:path";

import type { MessagePart, UIMessage } from "@tanstack/ai";
import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { inputSegmentIds, provenance } from "./test-support";
import {
  MigratedThreadFileV2Schema,
  parseTranscriptV1,
  v1ToThreadFile,
} from "./thread-file";
import { expandToolResultData } from "./v1-to-ui-messages";

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
  // Bracket frames are paired: a close usually carries the id of the last
  // `created`, as the renderer writes them, so matched and late closes
  // (after a user text) are exercised, not only stray ones.
  const brackets: string[] = [];
  // Call ids are reused now and then: a pending marker then its result.
  const calls: string[] = [];

  const tool = (): Record<string, unknown> => {
    const callId =
      calls.length > 0 && random() < 0.15 ? pick(calls) : id("call");
    calls.push(callId);
    const status = pick(STATUSES);
    const withResult = random() < 0.6;
    const rejection = pick(REJECTIONS);
    const output = `out ${counter++}`;
    return {
      type: "tool_call",
      id: id("tool"),
      at: at(),
      toolCall: {
        id: callId,
        name: pick(["bash", "read", "edit", "write", "mcp__x__y", "odd"]),
        args: { n: counter++ },
        ...(status === undefined ? {} : { status }),
      },
      ...(withResult
        ? {
            toolResult: {
              toolCallId: callId,
              output,
              ...(random() < 0.2 ? { error: "boom" } : {}),
              ...(rejection === undefined
                ? {}
                : { rejection: { reason: rejection } }),
              ...(random() < 0.3
                ? {
                    data: pick([
                      { type: "generic", output },
                      { type: "bash", command: "ls", output },
                      { type: "generic", output: "other" },
                    ]),
                  }
                : {}),
            },
          }
        : {}),
    };
  };

  const simple = (): unknown => {
    const text = (prefix: string) => `${prefix} ${counter++}`;
    switch (Math.floor(random() * 14)) {
      case 0:
        return {
          type: "text",
          id: id("user"),
          source: "user",
          content: text("hi"),
          at: at(),
          ...(random() < 0.5 ? { messageIndex: messageIndex++ } : {}),
        };
      case 1:
        return {
          type: "text",
          id: id("bot"),
          source: "bot",
          content: text("hello"),
          at: at(),
          ...(random() < 0.4 ? { messageIndex: messageIndex++ } : {}),
          ...(random() < 0.2 ? { regenerateAttempt: 1 } : {}),
        };
      case 2:
        return {
          type: "thinking",
          id: id("think"),
          content: text("hmm"),
          at: at(),
        };
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
      case 5: {
        const bracket = id("sub");
        brackets.push(bracket);
        return {
          type: "subtask",
          id: bracket,
          status: "created",
          at: at(),
          ...(random() < 0.5 ? { kind: pick(["browser", "component"]) } : {}),
        };
      }
      case 6:
        return {
          type: "subtask",
          id:
            brackets.length > 0 && random() < 0.8 ? pick(brackets) : id("sub"),
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
          message: text("m"),
          severity: "info",
        };
      case 9:
        return {
          type: "media",
          id: id("media"),
          media: {
            kind: pick(["image", "video", "audio"]),
            url: `https://example.com/${counter++}`,
            width: 1,
            height: 1,
            loop: false,
          },
        };
      case 10:
        return { type: "compaction", id: id("compact"), summary: text("s") };
      case 11:
        return {
          type: "web_search_results",
          id: id("search"),
          query: text("q"),
          resultType: "web",
          results: [],
        };
      case 12:
        // Malformed on purpose: the only values allowed to map to unknown.
        return pick(MALFORMED)();
      default:
        return {
          type: "collapsible",
          id: id("fold"),
          content: text("c"),
          title: "t",
        };
    }
  };

  return Array.from({ length: Math.floor(random() * 40) }, simple);
};

/** Values the generator makes invalid on purpose. */
const MALFORMED: ReadonlyArray<() => unknown> = [
  () => ({ type: "mystery", id: "x" }),
  () => null,
  () => 7,
  () => ({ type: "text", source: "bot", content: 1 }),
  () => ({
    type: "tool_call",
    id: "bad-call",
    toolCall: { id: "c", name: 7, args: [1, 2] },
  }),
  () => ({
    type: "tool_call",
    id: "nameless",
    toolCall: { id: "n", name: "" },
  }),
];

const isMalformed = (value: unknown): boolean =>
  typeof value !== "object" ||
  value === null ||
  (value as { type?: unknown }).type === "mystery" ||
  ((value as { type?: unknown }).type === "text" &&
    typeof (value as { content?: unknown }).content !== "string") ||
  // A media kind the mapper has no part for.
  ((value as { type?: unknown }).type === "media" &&
    (value as { media: { kind: string } }).media.kind === "audio") ||
  ((value as { type?: unknown }).type === "tool_call" &&
    ["bad-call", "nameless"].includes(String((value as { id?: unknown }).id)));

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
      // Its result follows at once, paired by id, named after the segment.
      const next = message.parts[index + 1];
      return (
        tagged(part.metadata) &&
        next?.type === "tool-result" &&
        next.toolCallId === part.id &&
        next.id !== undefined &&
        (next.id === `${segmentId}#result` ||
          next.id.startsWith(`${segmentId}#result#`))
      );
    }
    case "thinking":
      return part.stepId === segmentId;
    case "subagent":
      return (
        ((part.subagent.metadata as { abacus?: { segmentId?: string } })?.abacus
          ?.segmentId ?? part.subagent.id) === segmentId
      );
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

type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every input value in the mapper's walk order, group members included. */
const flatten = (segments: readonly unknown[]): unknown[] =>
  segments.flatMap((segment) =>
    isRec(segment) &&
    segment.type === "tool_group" &&
    Array.isArray(segment.tools)
      ? [segment, ...flatten(segment.tools)]
      : [segment]
  );

/** What a well-formed segment's part must hold (content fidelity). */
const expectedContent = (segment: Rec): unknown => {
  switch (segment.type) {
    case "text":
    case "thinking":
    case "collapsible":
      return segment.content;
    case "compaction":
      return segment.summary;
    case "web_search_results":
      return segment.query;
    case "notification":
      return segment.message;
    case "media":
      return (segment.media as Rec).url;
    default:
      return undefined;
  }
};

const partContent = (part: MessagePart): unknown => {
  switch (part.type) {
    case "text":
    case "thinking":
      return part.content;
    case "image":
    case "video":
      return part.source.value;
    default:
      return undefined;
  }
};

const kindOf = (part: MessagePart | undefined): string | undefined =>
  (
    (part as { metadata?: unknown } | undefined)?.metadata as
      | { abacus?: { kind?: string } }
      | undefined
  )?.abacus?.kind;

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

    // Only malformed input maps to `unknown` (generated cases).
    if (_name.startsWith("generated")) {
      const unknownParts = hits.filter(
        ({ entry, message }) =>
          entry.partIndex !== null &&
          kindOf(message?.parts[entry.partIndex]) === "unknown"
      );
      expect(unknownParts.length).toBe(
        flatten(segments).filter(isMalformed).length
      );
    }

    // Content fidelity: a segment with a unique id holds its own content.
    const byId = new Map<string, Rec[]>();
    for (const value of flatten(segments))
      if (isRec(value) && typeof value.id === "string")
        byId.set(value.id, [...(byId.get(value.id) ?? []), value]);
    for (const { entry, message } of hits) {
      const sources = byId.get(entry.id);
      if (entry.partIndex === null || sources?.length !== 1) continue;
      const source = sources[0]!;
      const part = message!.parts[entry.partIndex]!;
      if (kindOf(part) === "unknown") {
        expect(
          ((part as { metadata?: unknown }).metadata as { abacus: Rec }).abacus
            .raw
        ).toBe(source);
        continue;
      }
      const expected = expectedContent(source);
      if (expected !== undefined)
        expect({ id: entry.id, content: partContent(part) }).toEqual({
          id: entry.id,
          content: expected,
        });
      if (part.type === "tool-call" && isRec(source.toolCall)) {
        const call = source.toolCall;
        const result = isRec(source.toolResult) ? source.toolResult : undefined;
        const next = message!.parts[entry.partIndex + 1];
        expect(part.name).toBe(call.name);
        expect(JSON.parse(part.arguments)).toEqual(call.args ?? {});
        expect(next?.type === "tool-result" && next.content).toBe(
          result?.output ?? ""
        );
        // The legacy data survives the storage dedupe.
        if (next?.type === "tool-result" && result?.data !== undefined)
          expect(expandToolResultData(next)).toEqual(result.data);
      }
    }

    // The schema.
    const parsed = v.safeParse(MigratedThreadFileV2Schema, file);
    expect(parsed.issues?.map((issue) => issue.message) ?? []).toEqual([]);

    const everyMessage = allMessages(file.messages);
    const parts = everyMessage.flatMap((message) => message.parts);
    // Outcome implies error.
    for (const part of parts)
      if (part.type === "tool-result" && part.outcome !== undefined)
        expect(part.state).toBe("error");
    // Ids unique: messages, tool calls, results, sub-agents.
    const unique = (ids: Array<string | undefined>) =>
      expect(new Set(ids).size).toBe(ids.length);
    unique(everyMessage.map((message) => message.id));
    unique(
      parts.flatMap((part) => (part.type === "tool-call" ? [part.id] : []))
    );
    unique(
      parts.flatMap((part) => (part.type === "tool-result" ? [part.id] : []))
    );
    unique(
      parts.flatMap((part) =>
        part.type === "subagent" ? [part.subagent.id] : []
      )
    );
    // Every call has exactly one result, and the call stores no output.
    for (const part of parts)
      if (part.type === "tool-call") {
        expect(part.output).toBeUndefined();
        expect(
          parts.filter(
            (other) =>
              other.type === "tool-result" && other.toolCallId === part.id
          )
        ).toHaveLength(1);
      }

    // Deterministic, and stable across a JSON round trip of the input.
    const again = convert(JSON.parse(JSON.stringify(segments)) as unknown[]);
    expect(JSON.stringify(again)).toBe(JSON.stringify(file));
  });
});

describe("C-T2 edge cases", () => {
  it("allocates repeated ids in linear time", () => {
    const segments = Array.from({ length: 8000 }, () => ({
      type: "text",
      id: "same",
      source: "user",
      content: "x",
    }));
    const started = performance.now();
    const file = convert(segments);
    const elapsed = performance.now() - started;
    expect(file.messages.map((message) => message.id).slice(0, 3)).toEqual([
      "same",
      "same#2",
      "same#3",
    ]);
    expect(new Set(file.messages.map((message) => message.id)).size).toBe(8000);
    // Quadratic allocation took seconds here; linear takes milliseconds.
    expect(elapsed).toBeLessThan(1500);
  });
});
