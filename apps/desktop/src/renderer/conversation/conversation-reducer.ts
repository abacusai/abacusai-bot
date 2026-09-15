/**
 * Pure conversation reducer over the events the live server loop emits;
 * unknown events are a no-op. Orphans are finalized at turn/run boundaries,
 * never on `text_delta`, since text streams while tools are still in flight.
 * Deterministic: segment ids come from a counter in state.
 */
import type {
  PermissionRequest,
  REJECTION_REASON,
  ToolResult,
} from "./agent-types";
import { conversationSegmentsToSegments } from "./hydration";
import type {
  CollapsibleSegment,
  ConversationEvent,
  ConversationInternalState,
  ConversationLoopEvent,
  ConversationState,
  FileWriteSegment,
  NotificationSegment,
  PendingSegment,
  Segment,
  SubtaskSegment,
  SubtaskStatus,
  TerminalCommandSegment,
  TextSegment,
  ThinkingSegment,
  ToolCallSegment,
} from "./types";
import { createTool } from "./types";

/** Trailing file lines shown live while a write streams. */
export const MAX_FILE_TAIL_LINES = 7;

export const PROCESSING_SPINNER_TITLE = "Processing request";
export const ANALYZING_SPINNER_TITLE = "Analyzing result";

/**
 * Rejection reason for tool calls orphaned by an interrupt, pinned at the type
 * level to `REJECTION_REASON.INTERRUPTED`; declared locally because the agent
 * barrel cannot be imported at runtime here.
 */
const INTERRUPTED_REASON: `${REJECTION_REASON.INTERRUPTED}` = "interrupted";

function createInternal(generation: number): ConversationInternalState {
  return {
    generation,
    counter: 0,
    activeSubtaskId: null,
    turn: {
      textSegmentId: null,
      textMessageId: null,
      thinkingSegmentId: null,
      toolCallIds: [],
      pendingCredits: 0,
      notificationKeys: {},
    },
  };
}

export function createInitialConversationState(
  generation = 0
): ConversationState {
  return {
    segments: [],
    status: "idle",
    title: null,
    queuedMessages: [],
    pendingPermission: null,
    retry: null,
    online: true,
    credits: 0,
    spinner: null,
    error: null,
    subtasks: {},
    serverTodos: [],
    checkpoints: [],
    internal: createInternal(generation),
  };
}

/**
 * Working copy for one reduction: arrays/records are cloned up front, and
 * segments are replaced rather than mutated. The input state is never touched.
 */
type Draft = ConversationState;

function draft(state: ConversationState): Draft {
  return {
    ...state,
    segments: [...state.segments],
    internal: {
      ...state.internal,
      turn: {
        ...state.internal.turn,
        toolCallIds: [...state.internal.turn.toolCallIds],
      },
    },
  };
}

function allocId(d: Draft, prefix: string): string {
  const id = `${prefix}:${d.internal.generation}:${d.internal.counter}`;
  d.internal.counter += 1;
  return id;
}

/** The `<generation>` an allocated id carries, or -1 for ids from elsewhere. */
const ID_GENERATION_RE = /^[a-z_]+:(\d+):\d+$/;

function idGeneration(id: string): number {
  const match = ID_GENERATION_RE.exec(id);
  return match?.[1] === undefined ? -1 : Number(match[1]);
}

/**
 * Restored segments with distinct ids: a transcript may hold the same id
 * twice. The first occurrence keeps its id so references still resolve.
 */
function withDistinctIds(segments: Segment[]): Segment[] {
  const seen = new Set<string>();
  return segments.map((segment) => {
    if (!seen.has(segment.id)) {
      seen.add(segment.id);
      return segment;
    }
    let suffix = 2;
    while (seen.has(`${segment.id}#${suffix}`)) suffix += 1;
    const id = `${segment.id}#${suffix}`;
    seen.add(id);
    return { ...segment, id };
  });
}

/**
 * One past the highest generation in the current state or the transcript.
 * Tool and sub-agent ids come from the agent, not allocId, and are skipped.
 */
function nextGeneration(state: ConversationState, segments: Segment[]): number {
  let highest = state.internal.generation;
  for (const segment of segments) {
    const generation = idGeneration(segment.id);
    if (generation > highest) highest = generation;
  }
  return highest + 1;
}

function resetTurnCursors(d: Draft): void {
  d.internal.turn.textSegmentId = null;
  d.internal.turn.textMessageId = null;
  d.internal.turn.thinkingSegmentId = null;
  d.internal.turn.toolCallIds = [];
  d.internal.turn.notificationKeys = {};
}

/** Index of the most-recent still-open file-write segment for a path, or -1. */
function findOpenWrite(
  segments: Segment[],
  filepath: string,
  toolCallId?: string
): number {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (
      s &&
      s.type === "file_write" &&
      s.filepath === filepath &&
      !s.fileWriteDone &&
      (toolCallId === undefined || segmentToolCallId(s) === toolCallId)
    ) {
      return i;
    }
  }
  return -1;
}

/** Index of the most-recent file-write segment for a path (open or done), or -1. */
function findAnyWrite(
  segments: Segment[],
  filepath: string,
  toolCallId?: string
): number {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (
      s &&
      s.type === "file_write" &&
      s.filepath === filepath &&
      (toolCallId === undefined || segmentToolCallId(s) === toolCallId)
    )
      return i;
  }
  return -1;
}

/**
 * Index of an open write whose path is still arriving, or -1. A producer that
 * re-parses partial tool arguments emits an id-less writing frame per decoded
 * prefix ("C:\\Users\\m", "C:\\Users\\me", …), so an id-less open write whose
 * path is a prefix of the incoming one (or the reverse) is the same write.
 */
function findArrivingWrite(segments: Segment[], filepath: string): number {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    // A card that already has an id correlates by id; never fold it in by path.
    if (
      !s ||
      s.type !== "file_write" ||
      s.fileWriteDone ||
      segmentToolCallId(s)
    )
      continue;
    if (s.filepath === filepath) return i;
    if (filepath.startsWith(s.filepath) || s.filepath.startsWith(filepath))
      return i;
  }
  return -1;
}

/**
 * Close out result-less tool calls stranded at a boundary. With `toolCallIds`
 * only those are finalized (turn boundary); otherwise every orphan is.
 */
function finalizeOrphanedToolCalls(
  segments: Segment[],
  toolCallIds?: string[]
): Segment[] {
  const idSet = toolCallIds ? new Set(toolCallIds) : null;
  const inScope = (id: string | undefined): boolean =>
    idSet === null || (id !== undefined && idSet.has(id));
  return segments.map((s) => {
    // A dispatched tool_call whose result never arrived.
    if (s.type === "tool_call" && s.status === "transient" && !s.tool.result) {
      if (!inScope(s.id)) return s;
      const toolResult: ToolResult = {
        toolCallId: s.tool.call.id,
        output: JSON.stringify({ reason: INTERRUPTED_REASON }),
        rejection: { reason: INTERRUPTED_REASON },
        data: {
          type: "generic",
          output: JSON.stringify({ reason: INTERRUPTED_REASON }),
        },
      };
      const finalized: ToolCallSegment = {
        ...s,
        status: "completed",
        tool: createTool({ ...s.tool.call, status: "interrupted" }, toolResult),
      };
      return finalized;
    }

    // Reads, grep and glob emit no tool_result, so one still pending at a
    // boundary has in fact succeeded and is realized. Other pendings are
    // dropped at the run boundary, indistinguishable from interrupted.
    if (
      s.type === "pending" &&
      (s.tool.call.name === "read" ||
        s.tool.call.name === "grep" ||
        s.tool.call.name === "glob") &&
      !s.tool.result
    ) {
      if (!inScope(segmentToolCallId(s))) return s;
      const isRead = s.tool.call.name === "read";
      const finalized: ToolCallSegment = {
        id: s.id,
        status: "completed",
        source: s.source,
        type: "tool_call",
        tool: createTool(
          { ...s.tool.call, status: "success" },
          isRead
            ? {
                toolCallId: s.tool.call.id,
                output: "",
                data: { type: "read", content: "", lineCount: 0 },
              }
            : {
                toolCallId: s.tool.call.id,
                output: "",
                data: { type: "generic", output: "" },
              }
        ),
        ...(s.subtaskId !== undefined && { subtaskId: s.subtaskId }),
      };
      return finalized;
    }

    if (
      (s.type === "terminal_command" ||
        s.type === "file_read" ||
        s.type === "file_write") &&
      s.status === "transient" &&
      !s.tool.result
    ) {
      if (!inScope(segmentToolCallId(s))) return s;
      return {
        ...s,
        status: "completed",
        tool: createTool({ ...s.tool.call, status: "abandoned" }),
      };
    }

    return s;
  });
}

function isTempSpinner(s: Segment): boolean {
  return s.type === "collapsible" && s.temp === true;
}

function isSpinnySegment(s: Segment): boolean {
  return (s.type === "collapsible" || s.type === "thinking") && s.isSpinny;
}

/**
 * Drop spinny collapsibles; a spinny thinking segment is completed in place
 * since its content is real output.
 */
function removeSpinny(segments: Segment[], receivedAt?: number): Segment[] {
  const out: Segment[] = [];
  for (const s of segments) {
    if (!isSpinnySegment(s)) {
      out.push(s);
      continue;
    }
    if (s.type === "thinking") {
      out.push({
        ...s,
        status: "completed",
        isSpinny: false,
        ...(receivedAt !== undefined && { thinkingEndTime: receivedAt }),
      });
    }
  }
  return out;
}

/** Drop trailing temp spinner segments (before appending real output). */
function dropTrailingTemp(segments: Segment[]): Segment[] {
  let end = segments.length;
  while (end > 0) {
    const s = segments[end - 1];
    if (s && isTempSpinner(s)) end -= 1;
    else break;
  }
  return end === segments.length ? segments : segments.slice(0, end);
}

function completeSegment(segments: Segment[], id: string | null): Segment[] {
  if (!id) return segments;
  return segments.map((s) =>
    s.id === id ? { ...s, status: "completed" as const } : s
  );
}

function makeTempSpinner(d: Draft, title: string): CollapsibleSegment {
  return {
    id: allocId(d, "spinner"),
    status: "transient",
    source: "bot",
    type: "collapsible",
    content: "",
    title,
    isSpinny: true,
    temp: true,
  };
}

/**
 * Mark the active text segment completed whenever a new bot segment begins,
 * so only the still-streaming last text stays transient.
 */
function flushText(d: Draft): void {
  const id = d.internal.turn.textSegmentId;
  d.internal.turn.textMessageId = null;
  if (!id) return;
  d.segments = completeSegment(d.segments, id);
  d.internal.turn.textSegmentId = null;
}

/** Flush the active thinking cursor: mark its segment completed. */
function flushThinking(d: Draft, receivedAt?: number): void {
  const id = d.internal.turn.thinkingSegmentId;
  if (!id) return;
  d.segments = d.segments.map((s) =>
    s.id === id && s.type === "thinking"
      ? {
          ...s,
          status: "completed" as const,
          isSpinny: false,
          ...(receivedAt !== undefined && { thinkingEndTime: receivedAt }),
        }
      : s
  );
  d.internal.turn.thinkingSegmentId = null;
}

/**
 * Start a fresh user turn: finalize orphans, drop temp spinners, echo the
 * message, show the processing spinner.
 */
function startUserTurn(d: Draft, userSeg: TextSegment): void {
  d.segments = [
    ...finalizeOrphanedToolCalls(d.segments.filter((s) => !isTempSpinner(s))),
    userSeg,
    makeTempSpinner(d, PROCESSING_SPINNER_TITLE),
  ];
  resetTurnCursors(d);
}

type NativeToolCard = Extract<
  Segment,
  { type: "terminal_command" | "file_write" | "file_read" }
>;

/**
 * File-mutation endpoints on both wire vocabularies. The raw wire emits its
 * writing frame before the tool request, so both matchers below must know
 * both or the call spawns a duplicate pending card beside the write card.
 */
const FILE_MUTATION_TOOL_ENDPOINTS = new Set([
  "performFileOperation",
  "file_write",
  "file_str_replace",
  "file_edit_lines",
]);

function isFileMutationEndpoint(endpoint: string | undefined): boolean {
  return endpoint !== undefined && FILE_MUTATION_TOOL_ENDPOINTS.has(endpoint);
}

function segmentToolCallId(segment: Segment): string | undefined {
  switch (segment.type) {
    case "tool_call":
    case "pending":
      return segment.tool.call.id;
    case "terminal_command":
    case "file_write":
    case "file_read":
      return segment.tool.call.id || segment.toolCallId;
    default:
      return undefined;
  }
}

/** The result a tool-ish segment has settled with, if it has settled at all. */
function settledResultOf(segment: Segment): ToolResult | undefined {
  switch (segment.type) {
    case "tool_call":
    case "terminal_command":
    case "file_read":
    case "file_write":
      return segment.tool.result;
    default:
      return undefined;
  }
}

function resultHasError(result: ToolResult | undefined): result is ToolResult {
  return result?.error !== undefined || result?.rejection !== undefined;
}

function toolCallStatus(
  result: ToolResult
): ToolCallSegment["tool"]["call"]["status"] {
  return result.rejection
    ? result.rejection.reason === "interrupted"
      ? "interrupted"
      : result.rejection.reason === "sibling_failed"
        ? "skipped"
        : "rejected"
    : result.error
      ? "error"
      : "success";
}

function pendingMatchesCard(
  pending: PendingSegment,
  card: NativeToolCard
): boolean {
  if (card.type === "terminal_command") {
    return (
      pending.tool.call.name === "bash" &&
      (pending.tool.call.args["command"] === card.cmdline ||
        pending.cmdline === card.cmdline)
    );
  }
  if (!isFileMutationEndpoint(pending.tool.call.endpoint)) return false;
  const filepath = pending.tool.call.args["path"] ?? pending.filepath;
  if (filepath !== card.filepath) return false;
  if (card.type === "file_read") {
    const command = pending.tool.call.args["command"];
    return command === "view" || command === "view_raw";
  }
  return true;
}

function attachNativeCard(
  card: NativeToolCard,
  pending: PendingSegment
): NativeToolCard {
  return {
    ...card,
    // The placeholder is the authority on sub-agent scope if the realized
    // event arrived untagged.
    ...(card.subtaskId === undefined &&
      pending.subtaskId !== undefined && { subtaskId: pending.subtaskId }),
    // `id` is deliberately kept; see attachToolCallToRealizedCard.
    toolCallId: pending.tool.call.id,
    tool: createTool(
      {
        ...pending.tool.call,
        status: card.status === "completed" ? "success" : "executing",
      },
      card.tool.result === undefined
        ? undefined
        : { ...card.tool.result, toolCallId: pending.tool.call.id }
    ),
  };
}

/**
 * Fold a newer terminal card into the one on screen: take the incoming output
 * and lifecycle, keep the identity. Replacing wholesale would lose what the
 * dispatch placeholder contributed and remount the card on every chunk.
 */
function mergeTerminalCard(
  existing: TerminalCommandSegment,
  incoming: TerminalCommandSegment
): TerminalCommandSegment {
  const call =
    existing.tool.call.name.length > 0
      ? existing.tool.call
      : incoming.tool.call;
  return {
    ...existing,
    ...incoming,
    id: existing.id,
    ...(incoming.subtaskId === undefined &&
      existing.subtaskId !== undefined && { subtaskId: existing.subtaskId }),
    tool: createTool(
      {
        ...call,
        id: call.id.length > 0 ? call.id : incoming.tool.call.id,
        status: incoming.tool.call.status,
      },
      incoming.tool.result ?? existing.tool.result
    ),
  };
}

function mergeFileWriteCard(
  existing: FileWriteSegment,
  incoming: FileWriteSegment
): FileWriteSegment {
  return {
    ...incoming,
    ...existing,
    ...(incoming.fileWriteCommand !== undefined && {
      fileWriteCommand: incoming.fileWriteCommand,
    }),
  };
}

function completeFileWrite(
  segment: FileWriteSegment,
  isNewFile?: boolean
): FileWriteSegment {
  const finalContent = segment.fileWriteBuffer ?? segment.fileDiff ?? "";
  const existingData = segment.tool.result?.data;
  const fileMutationData =
    existingData?.type === "file_mutation" ? existingData : undefined;

  return {
    ...segment,
    status: "completed",
    fileWriteDone: true,
    tool: createTool(
      { ...segment.tool.call, status: "success" },
      {
        ...segment.tool.result,
        toolCallId: segment.tool.call.id,
        output: finalContent,
        data: {
          ...fileMutationData,
          type: "file_mutation",
          finalContent,
          isNewFile:
            isNewFile ??
            segment.fileWriteIsNewFile ??
            segment.fileWriteCommand === "create",
        },
      }
    ),
  };
}

/** Replace the matching dispatch placeholder with its native card, or append it. */
function replacePendingOrAppend(
  d: Draft,
  card: NativeToolCard,
  toolCallId?: string
): boolean {
  const idx =
    toolCallId !== undefined
      ? d.segments.findIndex(
          (segment) => segmentToolCallId(segment) === toolCallId
        )
      : d.segments.findIndex(
          (segment) =>
            segment.type === "pending" && pendingMatchesCard(segment, card)
        );
  const existing = idx >= 0 ? d.segments[idx] : undefined;
  // executeCommand completes from its local dispatcher result; a later backend
  // echo of the same call must not disturb it.
  if (
    card.type === "terminal_command" &&
    existing?.type === "tool_call" &&
    existing.tool.call.endpoint === "executeCommand" &&
    existing.tool.result !== undefined
  ) {
    return true;
  }

  // A final output chunk can land after completion; it must not drag the
  // settled card back into the shimmer.
  if (
    card.type === "terminal_command" &&
    card.status === "transient" &&
    existing !== undefined &&
    settledResultOf(existing) !== undefined
  ) {
    return true;
  }

  const segments = dropTrailingTemp(d.segments);
  if (idx >= 0) {
    const matched = segments[idx]!;
    // An error/rejection result is terminal; a later native success event
    // must not overwrite it.
    if (matched.type === "tool_call" && resultHasError(matched.tool.result)) {
      d.segments = segments;
      return false;
    }
    const realized =
      matched.type === "pending"
        ? attachNativeCard(card, matched)
        : matched.type === "file_write" && card.type === "file_write"
          ? mergeFileWriteCard(matched, card)
          : matched.type === "terminal_command" &&
              card.type === "terminal_command"
            ? mergeTerminalCard(matched, card)
            : card;
    d.segments = segments.map((segment, index) =>
      index === idx ? realized : segment
    );
  } else {
    d.segments = [
      ...segments,
      toolCallId === undefined
        ? card
        : {
            ...card,
            id: toolCallId,
            toolCallId,
            ...(card.tool.result !== undefined && {
              tool: createTool(card.tool.call, {
                ...card.tool.result,
                toolCallId,
              }),
            }),
          },
    ];
  }
  return false;
}

function nativeCardMatchesToolCall(
  segment: NativeToolCard,
  toolCall: Extract<ConversationLoopEvent, { type: "tool_call" }>["toolCall"]
): boolean {
  if (segment.id === toolCall.id) return true;
  if (segment.tool.call.id !== "") return segment.tool.call.id === toolCall.id;
  if (segment.type === "terminal_command") {
    return (
      toolCall.name === "bash" && toolCall.args["command"] === segment.cmdline
    );
  }
  if (
    !isFileMutationEndpoint(toolCall.endpoint) ||
    toolCall.args["path"] !== segment.filepath
  ) {
    return false;
  }
  const command = toolCall.args["command"];
  return (
    segment.type !== "file_read" || command === "view" || command === "view_raw"
  );
}

/**
 * Correlate an already-rendered card with its tool call. `segment.id` is left
 * alone: React keys, `ToolGroup.id` and per-card UI state all hang off it, and
 * rewriting it remounts the card mid-flight. The call id lands on `toolCallId`
 * and `tool.call.id`, where every consumer reads it.
 */
function attachToolCallToRealizedCard(
  segment: NativeToolCard,
  toolCall: Extract<ConversationLoopEvent, { type: "tool_call" }>["toolCall"]
): NativeToolCard {
  return {
    ...segment,
    toolCallId: toolCall.id,
    tool: createTool(
      {
        ...toolCall,
        status: segment.status === "completed" ? "success" : "executing",
      },
      segment.tool.result === undefined
        ? undefined
        : { ...segment.tool.result, toolCallId: toolCall.id }
    ),
  };
}

/**
 * Run boundary: close orphans, complete open text, clear spinners, flush
 * accumulated credits as a segment.
 */
function finalizeRun(d: Draft, receivedAt?: number): void {
  flushThinking(d, receivedAt);
  // A bracket with tools still in flight was cut short; detect before orphan
  // finalization stamps them. One with settled children is a normal handoff.
  const cutShortSubtasks = new Set<string>();
  for (const s of d.segments) {
    if (s.subtaskId === undefined) continue;
    const inFlight =
      s.type === "pending" ||
      ((s.type === "tool_call" ||
        s.type === "terminal_command" ||
        s.type === "file_read" ||
        s.type === "file_write") &&
        s.status === "transient" &&
        s.tool?.result === undefined);
    if (inFlight) cutShortSubtasks.add(s.subtaskId);
  }
  let segments = finalizeOrphanedToolCalls(d.segments);
  segments = segments.map((s) =>
    s.type === "subtask" && s.subtaskStatus === "running"
      ? {
          ...s,
          status: "completed" as const,
          subtaskStatus:
            d.error !== null || cutShortSubtasks.has(s.subtaskRef)
              ? ("interrupted" as const)
              : ("completed" as const),
          ...(receivedAt !== undefined && { subtaskEndTime: receivedAt }),
        }
      : s
  );
  // Placeholders have nothing to finalize; remove rather than leave a spinner.
  segments = segments.filter((s) => s.type !== "pending");
  // Every text segment, not just the cursor's: one left `transient` after a
  // cursor reset re-animates on every remount, forever.
  segments = segments.map((s) =>
    s.type === "text" && s.status === "transient"
      ? { ...s, status: "completed" as const }
      : s
  );
  segments = removeSpinny(segments, receivedAt);
  if (d.internal.turn.pendingCredits > 0) {
    segments = [
      ...segments,
      {
        id: allocId(d, "credits"),
        status: "completed",
        source: "bot",
        type: "credits",
        creditsUsed: d.internal.turn.pendingCredits,
      },
    ];
  }
  d.segments = segments;
  d.spinner = null;
  d.retry = null;
  // A stale bracket id would tag the next turn's work with a finished sub-agent.
  d.internal.activeSubtaskId = null;
  resetTurnCursors(d);
  d.internal.turn.pendingCredits = 0;
}

function appendNotification(d: Draft, seg: NotificationSegment): void {
  // A keyed notice rewrites one line in place, keeping its id. Only a line
  // this turn wrote (`turn.notificationKeys`): keys repeat across sessions and
  // a hydrated old line is an answer the user already read.
  if (seg.notificationKey != null) {
    const openLineId = d.internal.turn.notificationKeys[seg.notificationKey];
    const index =
      openLineId == null
        ? -1
        : d.segments.findIndex((segment) => segment.id === openLineId);

    if (index !== -1) {
      const existing = d.segments[index] as NotificationSegment;

      d.segments = [
        ...d.segments.slice(0, index),
        { ...seg, id: existing.id },
        ...d.segments.slice(index + 1),
      ];

      return;
    }

    d.internal.turn.notificationKeys[seg.notificationKey] = seg.id;
    d.segments = [...d.segments, seg];

    return;
  }

  // Flash a same-message notification instead of stacking a duplicate.
  const last = d.segments[d.segments.length - 1];
  if (
    last &&
    last.type === "notification" &&
    last.message === seg.message &&
    last.severity === seg.severity
  ) {
    d.segments = [
      ...d.segments.slice(0, -1),
      { ...last, flashKey: (last.flashKey ?? 0) + 1 },
    ];
    return;
  }
  d.segments = [...d.segments, seg];
}

/** Seed a `pending` placeholder from the permission request so it previews. */
function populatePendingMeta(
  seg: PendingSegment,
  request: PermissionRequest
): PendingSegment {
  switch (request.type) {
    case "edit_file":
    case "edit_outside_directory":
      return {
        ...seg,
        filepath: request.filePath,
        fileWriteCommand: "str_replace",
      };
    case "write_file":
      return {
        ...seg,
        filepath: request.filePath,
        fileWriteCommand: request.isNewFile ? "create" : "overwrite",
      };
    case "write_outside_directory":
      return {
        ...seg,
        filepath: request.filePath,
        fileWriteCommand: request.isNewFile ? "create" : "overwrite",
      };
    case "run_terminal":
      return { ...seg, cmdline: request.command };
    default:
      return seg;
  }
}

function reduceLoopEvent(
  state: ConversationState,
  event: ConversationLoopEvent,
  receivedAt?: number
): ConversationState {
  const d = draft(state);

  // Any progress other than the retry/offline signals means the retry worked.
  if (
    event.type !== "retry" &&
    event.type !== "network_status" &&
    d.retry !== null
  ) {
    d.retry = null;
  }

  switch (event.type) {
    case "status_changed": {
      d.status = event.status;
      if (event.status === "idle") finalizeRun(d, receivedAt);
      break;
    }

    case "text_delta": {
      d.status = "streaming";
      flushThinking(d, receivedAt);
      // A different wire message id is a new message: close the segment rather
      // than glue markdown across the boundary.
      if (
        event.messageId !== undefined &&
        d.internal.turn.textMessageId !== null &&
        event.messageId !== d.internal.turn.textMessageId
      ) {
        flushText(d);
      }
      const segments = removeSpinny(d.segments, receivedAt);
      const segId = d.internal.turn.textSegmentId;
      const existing = segId ? segments.find((s) => s.id === segId) : undefined;
      if (existing && existing.type === "text") {
        d.segments = segments.map((s) =>
          s.id === existing.id && s.type === "text"
            ? { ...s, content: s.content + event.content }
            : s
        );
        // An id-less segment adopts the first wire id so later changes flush.
        if (
          event.messageId !== undefined &&
          d.internal.turn.textMessageId === null
        ) {
          d.internal.turn.textMessageId = event.messageId;
        }
      } else {
        const id = allocId(d, "text");
        d.internal.turn.textSegmentId = id;
        d.internal.turn.textMessageId = event.messageId ?? null;
        d.segments = [
          ...segments,
          {
            id,
            status: "transient",
            source: "bot",
            type: "text",
            content: event.content,
            ...(event.subtaskId !== undefined && {
              subtaskId: event.subtaskId,
            }),
          },
        ];
      }
      break;
    }

    case "thinking_delta": {
      const segId = d.internal.turn.thinkingSegmentId;
      const existing = segId
        ? d.segments.find((s) => s.id === segId)
        : undefined;
      if (existing && existing.type === "thinking") {
        d.segments = d.segments.map((s) =>
          s.id === existing.id && s.type === "thinking"
            ? { ...s, content: s.content + event.content }
            : s
        );
      } else {
        const segments = dropTrailingTemp(d.segments);
        const id = allocId(d, "thinking");
        d.internal.turn.thinkingSegmentId = id;
        const seg: ThinkingSegment = {
          id,
          status: "transient",
          source: "bot",
          type: "thinking",
          content: event.content,
          isSpinny: true,
          ...(event.title !== undefined && { title: event.title }),
          ...(receivedAt !== undefined && { thinkingStartTime: receivedAt }),
          ...(event.subtaskId !== undefined && { subtaskId: event.subtaskId }),
        };
        d.segments = [...segments, seg];
      }
      break;
    }

    case "thinking_complete": {
      flushThinking(d, receivedAt);
      break;
    }

    case "collapsible": {
      flushThinking(d, receivedAt);
      flushText(d);
      const seg: CollapsibleSegment = {
        id: allocId(d, "collapsible"),
        status: "completed",
        source: "bot",
        type: "collapsible",
        content: event.content,
        isSpinny: event.isSpinny,
        ...(event.title !== undefined && { title: event.title }),
        ...(event.subtaskId !== undefined && { subtaskId: event.subtaskId }),
      };
      d.segments = [...dropTrailingTemp(d.segments), seg];
      break;
    }

    case "tool_result": {
      flushText(d);
      const segments = dropTrailingTemp(d.segments);
      const idx = segments.findIndex(
        (segment) => segmentToolCallId(segment) === event.toolCall.id
      );
      const existing = idx >= 0 ? segments[idx] : undefined;
      const existingResult =
        existing?.type === "tool_call" ||
        existing?.type === "terminal_command" ||
        existing?.type === "file_read" ||
        existing?.type === "file_write"
          ? existing.tool.result
          : undefined;
      const result =
        resultHasError(existingResult) && !resultHasError(event.result)
          ? existingResult
          : event.result;
      // Locally-synthesized tool_result events carry no subtaskId; dropping
      // the scope leaks the card into the main transcript.
      const existingSubtaskId = existing?.subtaskId;
      const realized: ToolCallSegment = {
        id: event.toolCall.id,
        status: "completed",
        source: "bot",
        type: "tool_call",
        tool: createTool(
          { ...event.toolCall, status: toolCallStatus(result) },
          result
        ),
        ...(existingSubtaskId !== undefined && {
          subtaskId: existingSubtaskId,
        }),
      };
      d.segments =
        idx >= 0
          ? segments.map((segment, index) =>
              index === idx ? realized : segment
            )
          : [...segments, realized];
      d.segments = [...d.segments, makeTempSpinner(d, ANALYZING_SPINNER_TITLE)];
      break;
    }

    case "tool_user_message": {
      const seg: TextSegment = {
        id: allocId(d, "text"),
        status: "completed",
        source: "user",
        type: "text",
        content: event.message,
      };
      d.segments = [...d.segments, seg];
      break;
    }

    case "notification": {
      appendNotification(d, {
        id: allocId(d, "notification"),
        status: "completed",
        source: "bot",
        type: "notification",
        severity: event.severity,
        message: event.message,
        ...(event.actions !== undefined && { actions: event.actions }),
        ...(typeof event.notificationKey === "string" && {
          notificationKey: event.notificationKey,
        }),
      });
      break;
    }

    case "web_search_results": {
      d.segments = [
        ...dropTrailingTemp(d.segments),
        {
          id: allocId(d, "web-search-results"),
          status: "completed",
          source: "bot",
          type: "web_search_results",
          query: event.query,
          resultType: event.resultType,
          results: event.results,
          ...(event.subtaskId !== undefined && { subtaskId: event.subtaskId }),
        },
      ];
      flushText(d);
      break;
    }

    case "media": {
      d.segments = [
        ...dropTrailingTemp(d.segments),
        {
          id: allocId(d, "media"),
          status: "completed",
          source: "bot",
          type: "media",
          media: event.media,
          ...(event.subtaskId !== undefined && { subtaskId: event.subtaskId }),
        },
      ];
      flushText(d);
      break;
    }

    case "feature_limit": {
      d.segments = [
        ...dropTrailingTemp(d.segments),
        {
          id: allocId(d, "feature-limit"),
          status: "completed",
          source: "bot",
          type: "feature_limit",
          featureName: event.featureName,
          limitType: event.limitType,
          ...(event.subtaskId !== undefined && { subtaskId: event.subtaskId }),
        },
      ];
      flushText(d);
      break;
    }

    case "compaction": {
      d.segments = [
        ...d.segments,
        {
          id: allocId(d, "compaction"),
          status: "completed",
          source: "bot",
          type: "compaction",
          compactionSummary: event.summary,
        },
      ];
      break;
    }

    case "subtask_start": {
      // Hard authorship boundary: the sub-agent's text must not continue the
      // main agent's open segment.
      flushThinking(d, receivedAt);
      flushText(d);
      d.internal.activeSubtaskId = event.id;
      d.subtasks = {
        ...d.subtasks,
        [event.id]: {
          id: event.id,
          ...(event.description !== undefined && {
            description: event.description,
          }),
          ...(event.kind !== undefined && { kind: event.kind }),
        },
      };
      // One card per bracket: a repeated `subtask_start` is a replay, not a
      // second agent.
      if (
        d.segments.some(
          (s) => s.type === "subtask" && s.subtaskRef === event.id
        )
      )
        break;
      // Children carry `subtaskId === event.id` and render inside this card.
      const seg: SubtaskSegment = {
        id: allocId(d, "subtask"),
        status: "transient",
        source: "bot",
        type: "subtask",
        subtaskRef: event.id,
        subtaskStatus: "running",
        ...(event.description !== undefined && {
          description: event.description,
        }),
        ...(event.kind !== undefined && { subtaskKind: event.kind }),
        ...(receivedAt !== undefined && { subtaskStartTime: receivedAt }),
      };
      d.segments = [...dropTrailingTemp(d.segments), seg];
      break;
    }

    case "subtask_end": {
      // The main agent's text must not continue the sub-agent's open segment.
      flushThinking(d, receivedAt);
      flushText(d);
      if (d.internal.activeSubtaskId === event.id)
        d.internal.activeSubtaskId = null;
      // A reported failure must not settle with a green tick; hosts that send
      // no status are assumed finished.
      const endedStatus: SubtaskStatus =
        event.status === "failed" ? "interrupted" : "completed";
      // Not restricted to "running" brackets: `finalizeRun` may have settled
      // this one by inference first, and the report is authoritative.
      d.segments = d.segments.map((s) =>
        s.type === "subtask" && s.subtaskRef === event.id
          ? {
              ...s,
              status: "completed" as const,
              subtaskStatus: endedStatus,
              ...(receivedAt !== undefined && { subtaskEndTime: receivedAt }),
            }
          : s
      );
      break;
    }

    case "error": {
      const errorSeg: NotificationSegment = {
        id: allocId(d, "notification"),
        status: "completed",
        source: "bot",
        type: "notification",
        severity: "error",
        message: event.error.message,
        ...(event.error.actions !== undefined && {
          actions: event.error.actions,
        }),
      };
      // `error` is terminal but not always followed by `status_changed: idle`
      // (a host timeout or killed CLI injects it bare), so finalize here too.
      // Set `d.error` first: finalizeRun reads it to stamp brackets interrupted.
      d.error = {
        message: event.error.message,
        ...(event.error.actions !== undefined && {
          actions: event.error.actions,
        }),
      };
      finalizeRun(d, receivedAt);
      d.segments = [...d.segments, errorSeg];
      d.status = "idle";
      break;
    }

    case "retry": {
      d.retry = {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        isNetworkError: event.isNetworkError,
      };
      break;
    }

    case "network_status": {
      d.online = event.online;
      break;
    }

    case "checkpoint_captured": {
      // Record the turn's snapshot (dedup by id) so rewind can map to it.
      if (!d.checkpoints.some((c) => c.id === event.checkpoint.id)) {
        d.checkpoints = [...d.checkpoints, event.checkpoint];
      }
      break;
    }

    case "credits": {
      d.internal.turn.pendingCredits += event.creditsUsed;
      d.credits += event.creditsUsed;
      break;
    }

    case "conversation_info": {
      if (event.title !== undefined) d.title = event.title;
      break;
    }

    case "spinner": {
      d.spinner = event.active ? event.title : null;
      break;
    }

    case "user_message_dequeued": {
      startUserTurn(d, {
        id: allocId(d, "text"),
        status: "completed",
        source: "user",
        type: "text",
        content: event.content,
      });
      break;
    }

    case "user_message_steered": {
      // Landed mid-turn: goes in ahead of the spinner, no cursor reset.
      const spinners = d.segments.filter(isTempSpinner);
      d.segments = [
        ...d.segments.filter((s) => !isTempSpinner(s)),
        {
          id: allocId(d, "text"),
          status: "completed",
          source: "user",
          type: "text",
          content: event.content,
        },
        ...spinners,
      ];
      break;
    }

    case "turn_complete": {
      flushThinking(d, receivedAt);
      d.segments = finalizeOrphanedToolCalls(
        d.segments,
        d.internal.turn.toolCallIds
      );
      flushText(d);
      d.spinner = null;
      d.internal.turn.toolCallIds = [];
      break;
    }

    // ── Native server-loop stream events ──────────────────────────────────

    case "tool_call": {
      flushThinking(d, receivedAt);
      flushText(d);
      if (d.status !== "waiting-for-tool-permission")
        d.status = "executing-tool";
      // One call, one row: a re-announced call refreshes its placeholder.
      if (event.toolCall.id !== "") {
        const dupIndex = d.segments.findIndex(
          (segment) =>
            segment.type === "pending" &&
            segment.tool.call.id === event.toolCall.id
        );
        if (dupIndex >= 0) {
          d.segments = d.segments.map((segment, index) =>
            index === dupIndex
              ? {
                  ...segment,
                  tool: createTool({ ...event.toolCall, status: "executing" }),
                }
              : segment
          );
          break;
        }
      }
      if (!d.internal.turn.toolCallIds.includes(event.toolCall.id))
        d.internal.turn.toolCallIds.push(event.toolCall.id);
      // Reverse scan: with repeated operations on a path the call is the newest.
      let realizedIndex = -1;
      for (let i = d.segments.length - 1; i >= 0; i--) {
        const segment = d.segments[i];
        if (
          segment &&
          (segment.type === "terminal_command" ||
            segment.type === "file_read" ||
            segment.type === "file_write") &&
          nativeCardMatchesToolCall(segment, event.toolCall)
        ) {
          realizedIndex = i;
          break;
        }
      }
      if (realizedIndex >= 0) {
        d.segments = d.segments.map((segment, index) =>
          index === realizedIndex &&
          (segment.type === "terminal_command" ||
            segment.type === "file_read" ||
            segment.type === "file_write")
            ? attachToolCallToRealizedCard(segment, event.toolCall)
            : segment
        );
        break;
      }
      // Placeholder for the permission UI, replaced by the realized event. For
      // bash, seed cmdline so the header shows the command while executing.
      const pendingCmdline =
        event.toolCall.name === "bash" &&
        typeof event.toolCall.args["command"] === "string"
          ? event.toolCall.args["command"]
          : undefined;
      const seg: PendingSegment = {
        id: allocId(d, "pending"),
        status: "transient",
        source: "bot",
        type: "pending",
        tool: createTool({ ...event.toolCall, status: "executing" }),
        ...(pendingCmdline !== undefined && { cmdline: pendingCmdline }),
        ...(event.subtaskId !== undefined && { subtaskId: event.subtaskId }),
      };
      d.segments = [...dropTrailingTemp(d.segments), seg];
      break;
    }

    case "terminal_command": {
      // `streaming` is output-so-far; completion arrives as `tool_result`.
      // The card stays transient with no result so `cmdOutput` reads as live.
      const streaming = event.streaming === true;
      const isRedundantConfirmation = replacePendingOrAppend(
        d,
        {
          id: allocId(d, "terminal"),
          status: streaming ? "transient" : "completed",
          source: "bot",
          type: "terminal_command",
          ...(event.subtaskId !== undefined && { subtaskId: event.subtaskId }),
          cmdline: event.cmdline,
          cmdOutput: event.output,
          tool: createTool(
            {
              id: event.toolCallId ?? "",
              name: "bash",
              args: { command: event.cmdline },
              status: streaming ? "executing" : "success",
            },
            streaming
              ? undefined
              : {
                  toolCallId: "",
                  output: event.output,
                  data: {
                    type: "bash",
                    command: event.cmdline,
                    output: event.output,
                  },
                }
          ),
        },
        event.toolCallId
      );
      if (isRedundantConfirmation) return state;
      flushText(d);
      break;
    }

    case "file_read": {
      replacePendingOrAppend(
        d,
        {
          id: allocId(d, "file_read"),
          status: "completed",
          source: "bot",
          type: "file_read",
          ...(event.subtaskId !== undefined && { subtaskId: event.subtaskId }),
          filepath: event.filepath,
          tool: createTool(
            {
              id: event.toolCallId ?? "",
              name: "read",
              args: { path: event.filepath },
              status: "success",
            },
            {
              toolCallId: "",
              output: "",
              data: { type: "read", content: "", lineCount: 0 },
            }
          ),
          ...(event.readRange !== undefined && { readRange: event.readRange }),
        },
        event.toolCallId
      );
      flushText(d);
      break;
    }

    case "file_write_start": {
      // Same write, path still arriving: adopt the longer path, one card.
      if (event.toolCallId === undefined) {
        const arriving = findArrivingWrite(d.segments, event.filepath);
        if (arriving >= 0) {
          d.segments = d.segments.map((s, i) =>
            i === arriving && s.type === "file_write"
              ? {
                  ...s,
                  filepath: event.filepath,
                  tool: createTool({
                    ...s.tool.call,
                    args: { ...s.tool.call.args, path: event.filepath },
                  }),
                  ...(event.command !== undefined && {
                    fileWriteCommand: event.command,
                  }),
                  ...(event.isNewFile !== undefined && {
                    fileWriteIsNewFile: event.isNewFile,
                  }),
                }
              : s
          );
          flushText(d);
          break;
        }
      }
      replacePendingOrAppend(
        d,
        {
          id: allocId(d, "file_write"),
          status: "transient",
          source: "bot",
          type: "file_write",
          ...(event.subtaskId !== undefined && { subtaskId: event.subtaskId }),
          filepath: event.filepath,
          fileWriteDone: false,
          fileWriteBuffer: "",
          fileTail: [],
          tool: createTool({
            id: event.toolCallId ?? "",
            name:
              event.command === "str_replace" || event.command === "insert"
                ? "edit"
                : "write",
            args: { path: event.filepath, command: event.command },
            status: "executing",
          }),
          ...(event.command !== undefined && {
            fileWriteCommand: event.command,
          }),
          ...(event.isNewFile !== undefined && {
            fileWriteIsNewFile: event.isNewFile,
          }),
        },
        event.toolCallId
      );
      flushText(d);
      break;
    }

    case "file_write_progress": {
      // Only the most-recent open write: two in flight on one path would
      // otherwise corrupt buffers.
      let idx = findOpenWrite(d.segments, event.filepath, event.toolCallId);
      // The body streams under the partially-decoded path, so fall back to the
      // arriving-path match or the chunks are dropped.
      if (idx === -1 && event.toolCallId === undefined)
        idx = findArrivingWrite(d.segments, event.filepath);
      if (idx === -1) break;
      d.segments = d.segments.map((s, i) => {
        if (i !== idx || s.type !== "file_write") return s;
        const buffer = (s.fileWriteBuffer ?? "") + event.contentChunk;
        const fileTail = buffer
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .slice(-MAX_FILE_TAIL_LINES);
        return { ...s, fileWriteBuffer: buffer, fileTail };
      });
      break;
    }

    case "file_write_done": {
      let idx = findOpenWrite(d.segments, event.filepath, event.toolCallId);
      // Without this the card never closes and spins "Creating …" forever.
      if (idx === -1 && event.toolCallId === undefined)
        idx = findArrivingWrite(d.segments, event.filepath);
      if (idx === -1) break;
      d.segments = d.segments.map((s, i) =>
        i === idx && s.type === "file_write"
          ? completeFileWrite(s, event.isNewFile)
          : s
      );
      break;
    }

    case "file": {
      // Body or unified diff. Attach to the most recent write card for the
      // path (it usually lands after file_write_done); create one if none.
      const command =
        event.action === "edit"
          ? "str_replace"
          : event.action === "overwrite"
            ? "overwrite"
            : "create";
      const patch = {
        fileWriteCommand: command,
        fileWriteIsNewFile: event.isNewFile ?? event.action === "new",
        ...(event.content !== undefined && { fileWriteBuffer: event.content }),
        ...(event.diff !== undefined && { fileDiff: event.diff }),
      };
      let idx = findOpenWrite(d.segments, event.filepath, event.toolCallId);
      if (idx === -1)
        idx = findAnyWrite(d.segments, event.filepath, event.toolCallId);
      if (idx === -1 && event.toolCallId === undefined)
        idx = findArrivingWrite(d.segments, event.filepath);
      if (idx === -1) {
        replacePendingOrAppend(
          d,
          {
            id: allocId(d, "file_write"),
            status: "transient",
            source: "bot",
            type: "file_write",
            ...(event.subtaskId !== undefined && {
              subtaskId: event.subtaskId,
            }),
            filepath: event.filepath,
            fileWriteDone: false,
            tool: createTool({
              id: event.toolCallId ?? "",
              name: event.action === "edit" ? "edit" : "write",
              args: { path: event.filepath, command },
              status: "executing",
            }),
            ...patch,
          },
          event.toolCallId
        );
      } else {
        d.segments = d.segments.map((s, i) =>
          i === idx && s.type === "file_write"
            ? s.fileWriteDone
              ? completeFileWrite({ ...s, ...patch })
              : { ...s, ...patch }
            : s
        );
      }
      flushText(d);
      break;
    }

    case "todos": {
      d.serverTodos = event.todos;
      break;
    }

    // Consumed by products; no conversation-state effect.
    case "mode_changed":
    case "sandbox_status":
      break;

    case "segments_cleared":
      // The agent's own `/clear`: same as the `reset` envelope, a fresh state
      // on a new generation so no id collides with the new transcript.
      return createInitialConversationState(state.internal.generation + 1);

    default:
      // Anything the server loop does not emit reduces to a no-op.
      break;
  }

  return d;
}

function reduceConversationEvent(
  state: ConversationState,
  event: ConversationEvent
): ConversationState {
  switch (event.kind) {
    case "event":
      return reduceLoopEvent(state, event.event, event.receivedAt);

    case "hydrate": {
      // The raw status sits at executing-tool while a permission is up.
      const live = state.status !== "idle" || state.pendingPermission != null;
      const segments = withDistinctIds(
        conversationSegmentsToSegments(event.segments, { live })
      );
      const credits = segments.reduce(
        (sum, s) => (s.type === "credits" ? sum + s.creditsUsed : sum),
        0
      );
      return {
        // Past the restored ids' generation, not just this state's: a reload
        // starts at 0, and a reused id merges two segments into one.
        ...createInitialConversationState(nextGeneration(state, segments)),
        segments,
        title: event.title ?? state.title,
        online: state.online,
        // A pending prompt and the turn status are live state the file never
        // held; dropping them on restore leaves the turn waiting on an answer
        // nobody can give.
        pendingPermission: state.pendingPermission,
        ...(live ? { status: state.status } : {}),
        credits,
        // Seed persisted checkpoints so rewind works right after (re)load.
        checkpoints: event.checkpoints ?? state.checkpoints,
      };
    }

    case "user_message": {
      const d = draft(state);
      startUserTurn(d, {
        id: allocId(d, "text"),
        status: "completed",
        source: "user",
        type: "text",
        content: event.content,
        ...(event.attachments !== undefined && {
          attachments: event.attachments,
        }),
      });
      d.status = "submitted";
      d.error = null;
      d.retry = null;
      return d;
    }

    case "agent_message": {
      const d = draft(state);
      // Appended, not started as a turn: the turn it answers is over, and its
      // spinner is already gone.
      d.segments = [
        ...d.segments.filter((s) => !isTempSpinner(s)),
        {
          id: allocId(d, "text"),
          status: "completed",
          source: "bot",
          type: "text",
          content: event.content,
        },
      ];
      return d;
    }

    case "permission": {
      const d = draft(state);
      d.pendingPermission = event.prompt;
      if (event.prompt) {
        // Fill the open placeholder so the pending card previews the operation.
        const request = event.prompt.request;
        const toolCallId = request.tool.id;
        for (let i = d.segments.length - 1; i >= 0; i--) {
          const s = d.segments[i];
          if (s && s.type === "pending" && s.tool.call.id === toolCallId) {
            const populated = populatePendingMeta(s, request);
            if (populated !== s) {
              d.segments = d.segments.map((seg, j) =>
                j === i ? populated : seg
              );
            }
            break;
          }
        }
      }
      return d;
    }

    case "queue":
      return { ...state, queuedMessages: event.entries };

    case "retract_user_message": {
      for (let i = state.segments.length - 1; i >= 0; i--) {
        const s = state.segments[i];
        if (s && s.type === "text" && s.source === "user") {
          return {
            ...state,
            segments: state.segments.filter((_, j) => j !== i),
          };
        }
      }
      return state;
    }

    case "reset":
      return createInitialConversationState(state.internal.generation + 1);

    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Cheap boundary guard; the shared transport schema performs full validation. */
function hasReducibleEnvelope(value: unknown): value is ConversationEvent {
  if (!isRecord(value) || typeof value["kind"] !== "string") return false;
  switch (value["kind"]) {
    case "event":
      return (
        isRecord(value["event"]) && typeof value["event"]["type"] === "string"
      );
    case "hydrate":
      return Array.isArray(value["segments"]);
    case "user_message":
    case "agent_message":
      return typeof value["content"] === "string";
    case "permission":
      return value["prompt"] === null || isRecord(value["prompt"]);
    case "queue":
      return Array.isArray(value["entries"]);
    case "retract_user_message":
    case "reset":
      return true;
    default:
      return false;
  }
}

/** Fault boundary: malformed local events are a no-op, never a crash. */
export function conversationReducer(
  state: ConversationState,
  event: unknown
): ConversationState {
  if (!hasReducibleEnvelope(event)) return state;
  try {
    return reduceConversationEvent(state, event);
  } catch {
    return state;
  }
}
