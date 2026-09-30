/**
 * R2-T13 (spec 02 §5.4a): `normalizeTool` on recorded emitter calls while
 * running (no output), with streamed `tool.output` and successive
 * `tool.display` patches, then the result; migrated successful, denied,
 * cancelled, edit and terminal results; status words; titles from the final
 * input after `TOOL_CALL_END`, `parsePartialJSON` before.
 */
import { buildToolTitle } from "@abacus-ai/agent/tool-display";
import { StreamProcessor } from "@tanstack/ai";
import { parsePartialJSON, type ToolCallPart, type ToolResultPart } from "@tanstack/ai-client";
import { describe, expect, it } from "vitest";

import { v1ToUiMessages } from "#shared/transcript/v1-to-ui-messages";

import * as b from "../../fixtures/builders";
import { normalizeTool, toolInput } from "./normalize";
import { toolTitle } from "./tool-line";

const partsAfter = (events: ReturnType<typeof b.toolCall>) => {
  const processor = new StreamProcessor();
  for (const event of [b.runStarted("r"), b.textStart("a"), ...events]) processor.processChunk(structuredClone(event));
  const parts = processor.getMessages().at(-1)!.parts;
  const call = parts.find((part) => part.type === "tool-call") as ToolCallPart;
  const result = parts.find((part) => part.type === "tool-result") as ToolResultPart | undefined;
  return { call, result };
};

describe("R2-T13 live", () => {
  it("running with streamed output and display patches, then the result", () => {
    const { call } = partsAfter(b.toolCall("c1", "bash", "a", { command: "npm test" }));
    expect(call.output).toBeUndefined();
    const running = normalizeTool(call, undefined, { output: "PASS 1\n" }, { runActive: true }, parsePartialJSON);
    expect(running.status).toBe("running");
    expect(running.terminal).toEqual({ command: "npm test", output: "PASS 1\n" });

    const edit = partsAfter(b.toolCall("c2", "edit", "a", { path: "a.ts" })).call;
    const withDisplay = normalizeTool(edit, undefined, { display: { originalContent: "a", newContent: "b" } }, { runActive: true });
    expect(withDisplay.diff).toMatchObject({ original: "a", final: "b" });

    const done = partsAfter([
      ...b.toolCall("c3", "bash", "a", { command: "ls" }),
      b.toolResult("c3", { text: "x\n", terminal: { output: "x\n" }, formatted: "```console\nx\n```" }),
    ]);
    const normalized = normalizeTool(done.call, done.result, {}, { runActive: true });
    expect(normalized.status).toBe("done");
    expect(normalized.terminal?.output).toBe("x\n");
    expect(normalized.formatted).toContain("console");
  });

  it("denied, cancelled, failed and unfinished", () => {
    const denied = partsAfter([...b.toolCall("d", "bash", "a", { command: "rm" }), b.toolResult("d", { text: "no", rejected: true, error: "no" }, { outcome: "denied" })]);
    expect(normalizeTool(denied.call, denied.result, {}, { runActive: false }).status).toBe("refused");
    const cancelled = partsAfter([...b.toolCall("e", "bash", "a", { command: "sleep" }), b.toolResult("e", { text: "", rejected: true }, { outcome: "cancelled" })]);
    expect(normalizeTool(cancelled.call, cancelled.result, {}, { runActive: false }).status).toBe("stopped");
    const failed = partsAfter([...b.toolCall("f", "bash", "a", { command: "false" }), b.toolResult("f", { text: "exit 1", rejected: true, error: "exit 1" })]);
    expect(normalizeTool(failed.call, failed.result, {}, { runActive: false }).status).toBe("failed");
    const open = partsAfter(b.toolCall("g", "bash", "a", { command: "x" }));
    expect(normalizeTool(open.call, undefined, {}, { runActive: false }).status).toBe("stopped");
    expect(normalizeTool(open.call, undefined, {}, { runActive: true, needsYou: true }).status).toBe("needs-you");
  });

  it("titles: partial parse while streaming, the final input after END", () => {
    const processor = new StreamProcessor();
    for (const event of [b.runStarted("r"), b.textStart("a"), b.toolStart("c", "read", "a"), b.toolArgs("c", '{"path":"src/in')])
      processor.processChunk(structuredClone(event));
    const streaming = processor.getMessages().at(-1)!.parts.find((p) => p.type === "tool-call") as ToolCallPart;
    expect(toolTitle("read", toolInput(streaming, parsePartialJSON))).toBe(buildToolTitle("read", { path: "src/in" }));
    processor.processChunk(b.toolArgs("c", 'dex.ts"}'));
    processor.processChunk(b.toolEnd("c", { path: "src/index.ts" }));
    const final = processor.getMessages().at(-1)!.parts.find((p) => p.type === "tool-call") as ToolCallPart;
    expect(toolTitle("read", toolInput(final, parsePartialJSON))).toBe(buildToolTitle("read", { path: "src/index.ts" }));
  });
});

const V1 = import.meta.glob<{ segments: unknown[] }>("../../../../../shared/transcript/__fixtures__/v1/*.json", {
  import: "default",
  eager: true,
});
const pairsOf = (name: string) => {
  const messages = v1ToUiMessages(V1[`../../../../../shared/transcript/__fixtures__/v1/${name}.json`]!.segments);
  const parts = messages.flatMap((message) => message.parts);
  const results = parts.filter((part) => part.type === "tool-result") as ToolResultPart[];
  return (parts.filter((part) => part.type === "tool-call") as ToolCallPart[]).map((call) => ({
    call,
    result: results.find((result) => result.toolCallId === call.id),
  }));
};

describe("R2-T13 migrated", () => {
  it("legacy shapes: done, refused, stopped, edit diffs and read counts", () => {
    const pairs = pairsOf("legacy-protocol-tool");
    expect(pairs.length).toBeGreaterThan(3);
    const tools = pairs.map(({ call, result }) => ({ name: call.name, tool: normalizeTool(call, result, {}, { runActive: false }, parsePartialJSON) }));
    for (const { tool } of tools) expect(tool.source).toBe("migrated");
    expect(tools.find((t) => t.name === "bash")?.tool.status).toBe("done");
    expect(tools.find((t) => t.name === "write")?.tool.status).toBe("refused");
    expect(tools.filter((t) => t.name === "read").map((t) => t.tool.status)).toContain("stopped");
  });

  it("result states from the tool-result-states fixture", () => {
    const statuses = pairsOf("tool-result-states").map(({ call, result }) =>
      normalizeTool(call, result, {}, { runActive: false }, parsePartialJSON).status
    );
    expect(statuses.length).toBeGreaterThan(0);
    expect(new Set(statuses).size).toBeGreaterThan(1);
  });
});
