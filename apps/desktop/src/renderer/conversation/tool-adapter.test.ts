import { describe, expect, it } from "vitest";

/**
 * What the tool UI is told about a shell command while it runs.
 *
 * The renderer decides "still running" from a single field — the render item's
 * `state` — and three separate pieces of UI hang off it: the group header
 * ("Running 1 command" vs "Ran 1 command"), the row's shimmer, and the
 * live-output preview. A card that settles on its first byte of output takes
 * all three down while the command is still going, which is exactly what a
 * long build looks like when the streaming update is mistaken for a result.
 *
 * The same field decides whether a row is allowed to say what it is doing at
 * all: `streamingArgs` renders an anonymous shimmering tool name, so a command
 * still waiting to print its first byte must not be marked as one whose
 * arguments are still arriving.
 *
 * These tests drive the real pipeline — reducer events in, render items out —
 * because the bug lived in the seam between them, not in either half.
 */
import {
  conversationReducer,
  createInitialConversationState,
} from "./conversation-reducer";
import { toToolRenderItem } from "./tool-adapter";
import type { ConversationState, PendingSegment, ToolSegment } from "./types";
import { createTool } from "./types";

const CALL_ID = "call-1";
const COMMAND = "npm run build";

const send = (state: ConversationState, event: unknown): ConversationState =>
  conversationReducer(state, { kind: "event", event });

/** The dispatch announcement, as the loop sends it before the tool runs. */
const dispatchBash = (state: ConversationState): ConversationState =>
  send(state, {
    type: "tool_call",
    toolCall: {
      id: CALL_ID,
      name: "bash",
      args: { command: COMMAND },
      status: "executing",
    },
  });

/** One `tool_output_update`, as the transport translates it. */
const streamOutput = (
  state: ConversationState,
  output: string
): ConversationState =>
  send(state, {
    type: "terminal_command",
    cmdline: COMMAND,
    output,
    toolCallId: CALL_ID,
    streaming: true,
  });

const complete = (
  state: ConversationState,
  output: string
): ConversationState =>
  send(state, {
    type: "tool_result",
    toolCall: {
      id: CALL_ID,
      name: "bash",
      args: { command: COMMAND },
      status: "success",
    },
    result: {
      toolCallId: CALL_ID,
      output,
      data: { type: "bash", command: COMMAND, output },
    },
  });

const isToolish = (type: string): boolean =>
  type === "tool_call" ||
  type === "terminal_command" ||
  type === "file_read" ||
  type === "file_write" ||
  type === "pending";

/** Every tool segment in the transcript, as the tool UI would see it. */
const toolItems = (state: ConversationState) =>
  state.segments
    .filter((segment): segment is ToolSegment => isToolish(segment.type))
    .map(toToolRenderItem);

const onlyTool = (state: ConversationState) => {
  const items = toolItems(state);
  expect(items).toHaveLength(1);
  return items[0]!;
};

const toolSegments = (state: ConversationState) =>
  state.segments.filter((segment) => isToolish(segment.type));

describe("a command that streams output while it runs", () => {
  it("stays running until its result arrives", () => {
    let state = dispatchBash(createInitialConversationState());
    expect(onlyTool(state).state).toBe("running");

    state = streamOutput(state, "compiling…");
    const streaming = onlyTool(state);
    expect(streaming.state).toBe("running");
    expect(streaming.liveOutput).toBe("compiling…");
    expect(streaming.result).toBeUndefined();
    // Arguments are not what is streaming here — the output is.
    expect(streaming.streamingArgs).toBe(false);

    state = complete(state, "compiling…\ndone");
    const done = onlyTool(state);
    expect(done.state).toBe("done");
    expect(done.result?.content).toBe("compiling…\ndone");
  });

  it("shows the latest output, still without settling the card", () => {
    let state = dispatchBash(createInitialConversationState());
    state = streamOutput(state, "step 1");
    state = streamOutput(state, "step 1\nstep 2");

    const item = onlyTool(state);
    expect(item.state).toBe("running");
    expect(item.liveOutput).toBe("step 1\nstep 2");
  });

  it("keeps one card with one identity across updates", () => {
    let state = dispatchBash(createInitialConversationState());
    state = streamOutput(state, "a");
    const firstId = toolSegments(state)[0]!.id;

    state = streamOutput(state, "ab");
    const segments = toolSegments(state);
    expect(segments).toHaveLength(1);
    // A new segment id per chunk would remount the card mid-stream, dropping
    // whatever the user had expanded.
    expect(segments[0]!.id).toBe(firstId);
    // The dispatch call survives the merge, so the card is still addressable.
    expect(onlyTool(state).id).toBe(CALL_ID);
  });

  it("does not let a late chunk resurrect a finished command", () => {
    let state = dispatchBash(createInitialConversationState());
    state = streamOutput(state, "working");
    state = complete(state, "working\ndone");
    state = streamOutput(state, "working");

    const item = onlyTool(state);
    expect(item.state).toBe("done");
    expect(item.result?.content).toBe("working\ndone");
  });

  it("settles a terminal card that was never marked streaming", () => {
    // The agent's own `terminal_command` event reports a command that already
    // ran; only the desktop bridge's translation of `tool_output_update` is
    // output-so-far.
    let state = dispatchBash(createInitialConversationState());
    state = send(state, {
      type: "terminal_command",
      cmdline: COMMAND,
      output: "done",
      toolCallId: CALL_ID,
    });

    const item = onlyTool(state);
    expect(item.state).toBe("done");
    expect(item.result?.content).toBe("done");
  });
});

/** A dispatch placeholder: the row a tool has before any output arrives. */
const pendingBash = (args: Record<string, unknown>): PendingSegment => ({
  id: "seg-1",
  status: "transient",
  source: "bot",
  type: "pending",
  tool: createTool({
    id: CALL_ID,
    name: "bash",
    args,
    status: "executing",
  }),
});

describe("toToolRenderItem", () => {
  it("labels a running command instead of hiding it behind the tool name", () => {
    // A command that prints nothing stays a placeholder for its whole run —
    // there is no output event to realize it into a terminal card. Its
    // arguments arrived complete with `tool_execution_start`, so the row can
    // say which command is running rather than shimmering the word "bash".
    const item = toToolRenderItem(
      pendingBash({ command: "k6 run homepage.js --vus 200" })
    );

    expect(item.streamingArgs).toBe(false);
    expect(item.state).toBe("running");
    expect(item.input["command"]).toBe("k6 run homepage.js --vus 200");
  });

  it("still shimmers a call whose arguments have not arrived", () => {
    expect(toToolRenderItem(pendingBash({})).streamingArgs).toBe(true);
  });

  it("reports a still-executing terminal segment as running output", () => {
    const item = toToolRenderItem({
      id: "terminal-1",
      status: "transient",
      source: "bot",
      type: "terminal_command",
      cmdline: COMMAND,
      cmdOutput: "half a line",
      tool: createTool({
        id: CALL_ID,
        name: "bash",
        args: { command: COMMAND },
        status: "executing",
      }),
    });

    expect(item.state).toBe("running");
    expect(item.liveOutput).toBe("half a line");
    expect(item.result).toBeUndefined();
  });
});
