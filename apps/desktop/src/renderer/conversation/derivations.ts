import type { ToolCall, ToolResult } from "./agent-types";
import type {
  ConversationState,
  Segment,
  SubtaskKind,
  SubtaskOutcome,
  SubtaskStatus,
  TextSegment,
  ThinkingSegment,
  ToolCallSegment,
  ToolSegment,
} from "./types";
import {
  createTool,
  getToolDisplayName,
  getToolLifecycleStatus,
} from "./types";

export type ToolGroupStatus = "executing" | "success" | "error" | "abandoned";

export interface ToolGroup {
  id: string;
  memberIds: string[];
  callIds: string[];
  summary: string;
  status: ToolGroupStatus;
  activeCallId: string | null;
  activeParams: string | null;
}

export type GroupedSegment =
  | { kind: "segment"; segmentId: string }
  | { kind: "tool_group"; groupId: string };

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TodoState {
  todos: TodoItem[];
  completed: number;
  inProgress: number;
  pending: number;
  total: number;
}

export type ConversationActivityKind =
  | "idle"
  | "offline"
  | "error"
  | "loading"
  | "submitted"
  | "thinking"
  | "streaming"
  | "executing"
  | "waiting-permission";

export interface ConversationActivity {
  kind: ConversationActivityKind;
  isProcessing: boolean;
  isWaitingForPermission: boolean;
  spinnerTitle: string | null;
  thinkingStartTime: number | null;
  thinkingEndTime: number | null;
  /**
   * The thinking segment still live (run active, nothing after it), or null.
   * Renderers key shimmer off this rather than the raw `isSpinny` bit.
   */
  activeThinkingId: string | null;
  /**
   * The bot text segment still streaming (run active, last segment), or null.
   * Keyed structurally so an earlier text can never stay stuck shimmering.
   */
  activeTextId: string | null;
  /**
   * The one tool allowed to blink: the last segment, run active, still
   * awaiting realization. Anything superseded renders settled even if no
   * result frame ever arrives.
   */
  activeToolCallId: string | null;
}

export interface ToolState {
  tool: NonNullable<ToolSegment["tool"]>;
  segment: ToolSegment;
  status: ToolGroupStatus;
}

export interface ConversationDerivations {
  messages: TextSegment[];
  tools: ReadonlyMap<string, ToolState>;
  groups: ToolGroup[];
  groupsById: ReadonlyMap<string, ToolGroup>;
  groupedSegments: GroupedSegment[];
  /** Segments minus transient spinner placeholders. */
  visibleSegments: Segment[];
  subtasks: SubtaskSummary[];
  todos: TodoState;
  activity: ConversationActivity;
}

/** A placeholder for the status line, never the transcript. */
export function isTransientSpinner(segment: Segment): boolean {
  if (segment.type === "collapsible")
    return segment.temp === true || segment.isSpinny;
  if (segment.type === "thinking") return segment.isSpinny;
  return false;
}

/**
 * Live summary of one sub-agent bracket, derived from its card plus the child
 * segments carrying `subtaskId === id`.
 */
export interface SubtaskSummary {
  id: string;
  segmentId: string;
  description?: string;
  kind?: SubtaskKind;
  status: SubtaskStatus;
  /** Why a finished run is not a plain success, for the card's label. */
  outcome?: SubtaskOutcome;
  startTime: number | null;
  endTime: number | null;
  toolCount: number;
  lastToolLabel?: string;
  /** First line of the final report. */
  textPreview?: string;
  /**
   * The full final report. User-facing: the parent agent is told not to
   * restate it, so if the card hides this the turn's deliverable is never shown.
   */
  textFinal?: string;
  /** One entry per message, in order. */
  narration: string[];
}

/**
 * One rendering scope: `null` is the main thread with sub-agent children
 * hidden behind their card; a subtask id is that sub-agent's children alone.
 */
export function scopeSegments(
  segments: Segment[],
  scope: string | null
): Segment[] {
  return scope === null
    ? segments.filter((segment) => segment.subtaskId === undefined)
    : segments.filter((segment) => segment.subtaskId === scope);
}

function sameSubtasks(
  left: SubtaskSummary[],
  right: SubtaskSummary[]
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index]!;
    const b = right[index]!;
    if (
      a.id !== b.id ||
      a.segmentId !== b.segmentId ||
      a.description !== b.description ||
      a.kind !== b.kind ||
      a.status !== b.status ||
      a.startTime !== b.startTime ||
      a.endTime !== b.endTime ||
      a.toolCount !== b.toolCount ||
      a.lastToolLabel !== b.lastToolLabel ||
      a.textPreview !== b.textPreview ||
      a.textFinal !== b.textFinal ||
      a.narration.length !== b.narration.length ||
      a.narration[a.narration.length - 1] !==
        b.narration[b.narration.length - 1]
    ) {
      return false;
    }
  }
  return true;
}

function deriveSubtasks(segments: Segment[]): SubtaskSummary[] {
  const byId = new Map<string, SubtaskSummary>();
  for (const segment of segments) {
    if (segment.type === "subtask") {
      byId.set(segment.subtaskRef, {
        id: segment.subtaskRef,
        segmentId: segment.id,
        ...(segment.description !== undefined && {
          description: segment.description,
        }),
        ...(segment.subtaskKind !== undefined && { kind: segment.subtaskKind }),
        status: segment.subtaskStatus,
        ...(segment.subtaskOutcome !== undefined && {
          outcome: segment.subtaskOutcome,
        }),
        startTime: segment.subtaskStartTime ?? null,
        endTime: segment.subtaskEndTime ?? null,
        toolCount: 0,
        narration: [],
      });
      continue;
    }
    const summary =
      segment.subtaskId !== undefined ? byId.get(segment.subtaskId) : undefined;
    if (!summary) continue;
    if (isToolSegment(segment)) {
      summary.toolCount += 1;
      const name = toolNameFor(segment);
      if (name !== undefined) summary.lastToolLabel = getToolDisplayName(name);
    } else if (segment.type === "text" && segment.content.trim().length > 0) {
      const trimmed = segment.content.trim();
      const firstLine = trimmed.split("\n", 1)[0];
      if (firstLine) summary.textPreview = firstLine;
      summary.textFinal = trimmed;
      summary.narration.push(trimmed);
    }
  }
  return [...byId.values()];
}

interface CachedGroupedSegment {
  item: GroupedSegment;
  start: number;
  end: number;
  group?: ToolGroup;
}

const EMPTY_TODOS: TodoState = Object.freeze({
  todos: [],
  completed: 0,
  inProgress: 0,
  pending: 0,
  total: 0,
});

function toolCallFor(segment: Segment): ToolCall | undefined {
  switch (segment.type) {
    case "tool_call":
    case "pending":
      return segment.tool.call;
    case "terminal_command":
    case "file_read":
    case "file_write":
      return segment.tool?.call;
    default:
      return undefined;
  }
}

function toolResultFor(segment: ToolSegment): ToolResult | undefined {
  return segment.tool?.result;
}

function toolNameFor(segment: Segment): string | undefined {
  if (segment.type === "file_read") return "read";
  return toolCallFor(segment)?.name;
}

function isToolSegment(segment: Segment): segment is ToolSegment {
  return (
    segment.type === "tool_call" ||
    segment.type === "pending" ||
    segment.type === "terminal_command" ||
    segment.type === "file_read" ||
    segment.type === "file_write"
  );
}

/**
 * Assistant text with nothing to read. Providers stream blank lines around
 * every tool call; letting those end a tool run splits it into one-tool rows.
 */
function isBlankText(segment: Segment): boolean {
  return segment.type === "text" && segment.content.trim().length === 0;
}

function isGroupable(segment: Segment): boolean {
  if (isToolSegment(segment)) return true;
  if (segment.type === "thinking" && !isTransientSpinner(segment)) return true;
  // Groupable so it cannot split a run; dropped below so it is never a member.
  if (isBlankText(segment)) return true;
  return false;
}

/** Mirrors the single-tool card's notion of displayable output. */
function hasDisplayableOutput(result: ToolResult | undefined): boolean {
  if (result === undefined) return false;
  // A rejection-only result carries a synthetic reason marker, not output.
  if (result.rejection !== undefined && result.error === undefined)
    return false;
  return (result.output ?? result.error ?? "").trim() !== "";
}

/**
 * Per-member status for the group header, mirroring the single-tool card so
 * the summary agrees with its members: a result-less abandoned member counts
 * as a success, and only a genuinely running one is "executing".
 */
function toolStatus(segment: ToolSegment): ToolGroupStatus {
  const call = toolCallFor(segment);
  if (!call) return "success";
  const result = toolResultFor(segment);
  const lifecycle = getToolLifecycleStatus(createTool(call, result));
  if (lifecycle === "running") return "executing";
  if (
    (lifecycle === "abandoned" || lifecycle === "interrupted") &&
    !hasDisplayableOutput(result)
  ) {
    return "success";
  }
  if (
    lifecycle === "error" ||
    lifecycle === "rejected" ||
    lifecycle === "interrupted"
  ) {
    return "error";
  }
  if (lifecycle === "abandoned") return "abandoned";
  return "success";
}

type ToolCategory =
  | "read"
  | "edit"
  | "command"
  | "code-search"
  | "search"
  | "other";

function categorize(name: string): ToolCategory {
  switch (name) {
    case "read":
    case "batch_file_read":
      return "read";
    case "write":
    case "edit":
    case "batch_edit":
      return "edit";
    case "grep":
    case "glob":
      return "code-search";
    case "web_search_text_only":
    case "scrape_url_content":
      return "search";
    case "bash":
      return "command";
    default:
      return "other";
  }
}

function categoryPhrase(
  category: ToolCategory,
  completed: number,
  executing: number
): string {
  const total = completed + executing;
  const live = executing > 0;
  switch (category) {
    case "read":
      return live
        ? `Reading ${total} ${total === 1 ? "file" : "files"}`
        : `Read ${completed} ${completed === 1 ? "file" : "files"}`;
    case "edit":
      return live
        ? `Changing ${total} ${total === 1 ? "file" : "files"}`
        : `Changed ${completed} ${completed === 1 ? "file" : "files"}`;
    case "code-search":
      return live
        ? `Searching code${total === 1 ? "" : ` ${total} times`}`
        : `Searched code ${completed} ${completed === 1 ? "time" : "times"}`;
    case "search":
      return live
        ? `Searching the web ${total} ${total === 1 ? "time" : "times"}`
        : `Searched the web ${completed} ${completed === 1 ? "time" : "times"}`;
    case "command":
      return live
        ? `Running ${total} ${total === 1 ? "command" : "commands"}`
        : `Ran ${completed} ${completed === 1 ? "command" : "commands"}`;
    case "other":
      return live
        ? `Using ${total} ${total === 1 ? "tool" : "tools"}`
        : `Used ${completed} ${completed === 1 ? "tool" : "tools"}`;
  }
}

const CATEGORY_ORDER: ToolCategory[] = [
  "read",
  "edit",
  "command",
  "code-search",
  "search",
  "other",
];

function summarize(toolSegments: ToolSegment[]): string {
  const counts = new Map<
    ToolCategory,
    { completed: number; executing: number }
  >();

  for (const segment of toolSegments) {
    const name =
      toolNameFor(segment) ?? toolCallFor(segment)?.name ?? "unknown";
    const category = categorize(name);
    const status = toolStatus(segment);
    const count = counts.get(category) ?? { completed: 0, executing: 0 };
    if (status === "executing") {
      count.executing += 1;
    } else {
      count.completed += 1;
    }
    counts.set(category, count);
  }

  const parts: string[] = [];
  for (const category of CATEGORY_ORDER) {
    const count = counts.get(category);
    if (count && (count.completed > 0 || count.executing > 0)) {
      parts.push(categoryPhrase(category, count.completed, count.executing));
    }
  }
  if (parts.length < 2) return parts[0] ?? "";
  const sentenceParts = parts.map((part, index) =>
    index === 0 ? part : `${part.charAt(0).toLowerCase()}${part.slice(1)}`
  );
  if (sentenceParts.length === 2) return sentenceParts.join(" and ");
  return `${sentenceParts.slice(0, -1).join(", ")}, and ${sentenceParts.at(-1)}`;
}

function activeParams(call: ToolCall): string | null {
  for (const key of [
    "path",
    "file_path",
    "filepath",
    "query",
    "command",
    "pattern",
  ]) {
    const value = call.args[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  for (const key of ["queries", "urls"]) {
    const value = call.args[key];
    if (Array.isArray(value)) {
      const first = value.find(
        (entry): entry is string => typeof entry === "string"
      );
      if (first?.trim()) return first;
    }
  }
  return null;
}

function makeGroup(members: Segment[], allowActive: boolean): ToolGroup {
  const memberIds = members.map((m) => m.id);
  const toolSegments = members.filter(isToolSegment);
  const callIds: string[] = [];
  let activeCall: ToolCall | null = null;
  let hasError = false;
  let hasAbandoned = false;

  const activeSegment = allowActive ? members.at(-1) : undefined;
  for (const segment of toolSegments) {
    const call = toolCallFor(segment);
    if (!call) continue;
    callIds.push(call.id);
    const status = toolStatus(segment);
    if (status === "executing" && segment === activeSegment) {
      activeCall = call;
    } else {
      if (status === "error") hasError = true;
      if (status === "abandoned") hasAbandoned = true;
    }
  }

  return {
    // Anchored to the first call so lifecycle replacements keep the React key
    // and expanded state.
    id: `tool-group:${callIds[0] ?? memberIds[0]!}`,
    memberIds,
    callIds,
    summary: summarize(toolSegments),
    status: activeCall
      ? "executing"
      : hasError
        ? "error"
        : hasAbandoned
          ? "abandoned"
          : "success",
    activeCallId: activeCall?.id ?? null,
    activeParams: activeCall ? activeParams(activeCall) : null,
  };
}

/**
 * A pending row followed by its result is one call, not two: keep only the
 * newest marker per call, in the position of the older one.
 */
function omitSupersededToolLifecycleSegments(
  segments: readonly Segment[]
): Segment[] {
  const seenCallIds = new Set<string>();
  const result: Segment[] = [];

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    const callId = toolCallFor(segment)?.id;
    if (callId !== undefined) {
      if (seenCallIds.has(callId)) continue;
      seenCallIds.add(callId);
    }
    result.push(segment);
  }

  result.reverse();
  return result;
}

/**
 * A maximal run of groupable segments (tools, settled thinking) becomes a
 * group when it has 2+ members and at least one tool. Runs break on scope
 * changes, not on tool errors, which the group status reflects.
 */
function deriveGroupedSuffix(
  segments: Segment[],
  start: number
): CachedGroupedSegment[] {
  const entries: CachedGroupedSegment[] = [];
  let index = start;
  while (index < segments.length) {
    const segment = segments[index]!;
    if (!isGroupable(segment)) {
      entries.push({
        item: { kind: "segment", segmentId: segment.id },
        start: index,
        end: index,
      });
      index += 1;
      continue;
    }

    const run: Segment[] = [segment];
    let cursor = index + 1;
    while (cursor < segments.length) {
      const candidate = segments[cursor]!;
      if (!isGroupable(candidate)) break;
      // Never group across a sub-agent scope boundary.
      if (candidate.subtaskId !== segment.subtaskId) break;
      run.push(candidate);
      cursor += 1;
    }

    const visibleRun = omitSupersededToolLifecycleSegments(run).filter(
      (member) => !isBlankText(member)
    );

    // Every tool run is one presentation row, a single call included.
    if (visibleRun.some(isToolSegment)) {
      const group = makeGroup(visibleRun, cursor === segments.length);
      entries.push({
        item: { kind: "tool_group", groupId: group.id },
        start: index,
        end: cursor - 1,
        group,
      });
    } else {
      for (let i = 0; i < visibleRun.length; i++) {
        const originalOffset = run.indexOf(visibleRun[i]!);
        entries.push({
          item: { kind: "segment", segmentId: visibleRun[i]!.id },
          start: index + originalOffset,
          end: index + originalOffset,
        });
      }
    }
    index = cursor;
  }
  return entries;
}

export function deriveToolGroups(segments: Segment[]): ToolGroup[] {
  return deriveGroupedSuffix(segments, 0).flatMap((entry) =>
    entry.group ? [entry.group] : []
  );
}

/** One-shot presentation derivation for a renderer-scoped transcript. */
export function deriveGroupedTranscript(segments: Segment[]): {
  groups: ToolGroup[];
  groupedSegments: GroupedSegment[];
} {
  const entries = deriveGroupedSuffix(segments, 0);
  return {
    groups: entries.flatMap((entry) => (entry.group ? [entry.group] : [])),
    groupedSegments: entries.map((entry) => entry.item),
  };
}

function latestTodoSegment(segments: Segment[]): ToolCallSegment | undefined {
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index];
    if (
      segment?.type === "tool_call" &&
      segment.tool.call.name === "todo_write"
    )
      return segment;
  }
  return undefined;
}

function isTodoStatus(value: string): value is TodoItem["status"] {
  return (
    value === "pending" || value === "in_progress" || value === "completed"
  );
}

function deriveTodos(segment: ToolCallSegment | undefined): TodoState {
  if (!segment) return EMPTY_TODOS;
  let rawTodos: unknown = segment.tool.call.args["todos"];
  if (typeof rawTodos === "string") {
    try {
      rawTodos = JSON.parse(rawTodos);
    } catch {
      return EMPTY_TODOS;
    }
  }
  if (!Array.isArray(rawTodos)) return EMPTY_TODOS;

  const todos: TodoItem[] = [];
  for (let index = 0; index < rawTodos.length; index++) {
    const raw = rawTodos[index];
    if (typeof raw !== "object" || raw === null) continue;
    const content = "content" in raw ? raw.content : undefined;
    const status = "status" in raw ? raw.status : undefined;
    const id = "id" in raw ? raw.id : undefined;
    if (typeof content !== "string" || typeof status !== "string") continue;
    if (status === "cancelled" || !isTodoStatus(status)) continue;
    todos.push({
      id: typeof id === "string" ? id : `todo-${index}`,
      content,
      status,
    });
  }

  return {
    todos,
    completed: todos.filter((todo) => todo.status === "completed").length,
    inProgress: todos.filter((todo) => todo.status === "in_progress").length,
    pending: todos.filter((todo) => todo.status === "pending").length,
    total: todos.length,
  };
}

/** TodoState from the server-loop plan (wire `super_agent_todos`). */
function todosFromServer(items: ConversationState["serverTodos"]): TodoState {
  return {
    todos: items,
    completed: items.filter((todo) => todo.status === "completed").length,
    inProgress: items.filter((todo) => todo.status === "in_progress").length,
    pending: items.filter((todo) => todo.status === "pending").length,
    total: items.length,
  };
}

function latestThinking(segments: Segment[]): ThinkingSegment | undefined {
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index];
    if (segment?.type === "thinking") return segment;
  }
  return undefined;
}

function activityKind(
  state: ConversationState,
  thinking: ThinkingSegment | undefined
) {
  if (!state.online) return "offline" as const;
  if (state.error) return "error" as const;
  if (state.status === "waiting-for-tool-permission")
    return "waiting-permission" as const;
  if (state.status === "loading-conversation") return "loading" as const;
  if (state.status === "executing-tool") return "executing" as const;
  if (thinking?.isSpinny) return "thinking" as const;
  if (state.status === "streaming") return "streaming" as const;
  if (state.status === "submitted") return "submitted" as const;
  return "idle" as const;
}

/** No result or completion has arrived for this tool yet. */
function isAwaitingRealization(segment: Segment): boolean {
  switch (segment.type) {
    case "pending":
      return true;
    case "tool_call":
    case "terminal_command":
    case "file_read":
      return (
        segment.status === "transient" && segment.tool?.result === undefined
      );
    case "file_write":
      return segment.status === "transient" && !segment.fileWriteDone;
    default:
      return false;
  }
}

/**
 * The one tool allowed to blink: the last segment (spinner placeholders
 * aside) while the run is active, iff still awaiting realization.
 */
function deriveActiveToolCallId(state: ConversationState): string | null {
  if (state.status === "idle") return null;
  for (let index = state.segments.length - 1; index >= 0; index--) {
    const segment = state.segments[index];
    if (!segment || isTransientSpinner(segment)) continue;
    if (isToolSegment(segment) && isAwaitingRealization(segment)) {
      return toolCallFor(segment)?.id ?? null;
    }
    return null;
  }
  return null;
}

function deriveActivity(state: ConversationState): ConversationActivity {
  const thinking = latestThinking(state.segments);
  const last = state.segments[state.segments.length - 1];
  // Live iff still the last segment and the run is active, whatever isSpinny.
  const isLive =
    thinking !== undefined &&
    thinking.isSpinny &&
    state.status !== "idle" &&
    last === thinking;
  // Only the last, transient text shimmers while the run is active.
  const activeText =
    last?.type === "text" &&
    last.source === "bot" &&
    last.status === "transient" &&
    state.status !== "idle"
      ? last
      : undefined;
  return {
    kind: activityKind(state, thinking),
    isProcessing: state.status !== "idle",
    isWaitingForPermission: state.status === "waiting-for-tool-permission",
    spinnerTitle: state.spinner,
    thinkingStartTime: thinking?.thinkingStartTime ?? null,
    thinkingEndTime: thinking?.thinkingEndTime ?? null,
    activeThinkingId: isLive ? thinking.id : null,
    activeTextId: activeText?.id ?? null,
    activeToolCallId: deriveActiveToolCallId(state),
  };
}

function sameActivity(
  left: ConversationActivity,
  right: ConversationActivity
): boolean {
  return (
    left.kind === right.kind &&
    left.isProcessing === right.isProcessing &&
    left.isWaitingForPermission === right.isWaitingForPermission &&
    left.spinnerTitle === right.spinnerTitle &&
    left.thinkingStartTime === right.thinkingStartTime &&
    left.thinkingEndTime === right.thinkingEndTime &&
    left.activeThinkingId === right.activeThinkingId &&
    left.activeTextId === right.activeTextId &&
    left.activeToolCallId === right.activeToolCallId
  );
}

function firstChangedIndex(previous: Segment[], next: Segment[]): number {
  const sharedLength = Math.min(previous.length, next.length);
  for (let index = 0; index < sharedLength; index++) {
    if (previous[index] !== next[index]) return index;
  }
  return previous.length === next.length ? -1 : sharedLength;
}

function sameReferences<T>(left: T[], right: T[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameSegmentRange(
  previous: Segment[],
  next: Segment[],
  start: number,
  end: number
): boolean {
  if (end >= previous.length || end >= next.length) return false;
  for (let index = start; index <= end; index++) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

function makeToolState(segment: ToolSegment): ToolState | undefined {
  const toolCall = toolCallFor(segment);
  if (!toolCall) return undefined;
  const toolResult = toolResultFor(segment);
  return {
    tool: createTool(toolCall, toolResult),
    segment,
    status: toolStatus(segment),
  };
}

export interface ConversationDerivationCache {
  update(state: ConversationState): ConversationDerivations;
}

/** Stateful memoizer owned by one conversation record in the external store. */
export function createConversationDerivationCache(): ConversationDerivationCache {
  let previousState: ConversationState | undefined;
  let previousSegments: Segment[] = [];
  let entries: CachedGroupedSegment[] = [];
  let messages: TextSegment[] = [];
  let tools = new Map<string, ToolState>();
  let groups: ToolGroup[] = [];
  let groupsById = new Map<string, ToolGroup>();
  let groupedSegments: GroupedSegment[] = [];
  let visibleSegments: Segment[] = [];
  let subtasks: SubtaskSummary[] = [];
  let todoSource: ToolCallSegment | undefined;
  let todos = EMPTY_TODOS;
  let todosDirty = false;
  let activity = deriveActivity({
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
    internal: {
      generation: 0,
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
    },
  });
  let result: ConversationDerivations = {
    messages,
    tools,
    groups,
    groupsById,
    groupedSegments,
    visibleSegments,
    subtasks,
    todos,
    activity,
  };

  return {
    update(state) {
      const changedIndex = firstChangedIndex(previousSegments, state.segments);
      let segmentDerivedChanged = false;

      if (changedIndex >= 0) {
        segmentDerivedChanged = true;
        const oldSuffix = previousSegments.slice(changedIndex);
        const newSuffix = state.segments.slice(changedIndex);

        const nextMessages = state.segments.filter(
          (segment): segment is TextSegment => segment.type === "text"
        );
        if (!sameReferences(messages, nextMessages)) messages = nextMessages;

        const nextTools = new Map(tools);
        for (const segment of oldSuffix) {
          const call = toolCallFor(segment);
          if (call) nextTools.delete(call.id);
        }
        for (const segment of newSuffix) {
          if (!isToolSegment(segment)) continue;
          const call = toolCallFor(segment);
          const previousTool = call ? tools.get(call.id) : undefined;
          const tool =
            previousTool?.segment === segment
              ? previousTool
              : makeToolState(segment);
          if (tool) nextTools.set(tool.tool.call.id, tool);
        }
        tools = nextTools;

        const previousEntries = entries;
        let entryIndex = entries.findIndex(
          (entry) => entry.end >= changedIndex
        );
        if (entryIndex < 0) entryIndex = entries.length;
        if (entryIndex > 0) entryIndex -= 1;
        const preserved = entries.slice(0, entryIndex);
        const restart =
          preserved.at(-1)?.end === undefined ? 0 : preserved.at(-1)!.end + 1;
        const rebuilt = deriveGroupedSuffix(state.segments, restart).map(
          (entry) => {
            const prior = previousEntries.find(
              (candidate) =>
                candidate.start === entry.start && candidate.end === entry.end
            );
            return prior &&
              prior.item.kind === entry.item.kind &&
              sameSegmentRange(
                previousSegments,
                state.segments,
                entry.start,
                entry.end
              )
              ? prior
              : entry;
          }
        );
        entries = [...preserved, ...rebuilt];
        const nextGroups = entries.flatMap((entry) =>
          entry.group ? [entry.group] : []
        );
        if (!sameReferences(groups, nextGroups)) {
          groups = nextGroups;
          groupsById = new Map(groups.map((group) => [group.id, group]));
        }
        const nextGroupedSegments = entries.map((entry) => entry.item);
        if (!sameReferences(groupedSegments, nextGroupedSegments)) {
          groupedSegments = nextGroupedSegments;
        }

        const nextVisibleSegments = state.segments.filter(
          (segment) => !isTransientSpinner(segment)
        );
        if (!sameReferences(visibleSegments, nextVisibleSegments)) {
          visibleSegments = nextVisibleSegments;
        }

        const nextTodoSource = latestTodoSegment(state.segments);
        if (nextTodoSource !== todoSource) {
          todoSource = nextTodoSource;
          todosDirty = true;
        }

        const nextSubtasks = deriveSubtasks(state.segments);
        if (!sameSubtasks(subtasks, nextSubtasks)) subtasks = nextSubtasks;
      }

      // The server-loop plan updates state without a segment change and is
      // the todo source of truth; the todo_write scan is the fallback.
      if (
        previousState === undefined ||
        previousState.serverTodos !== state.serverTodos
      ) {
        todosDirty = true;
      }
      if (todosDirty) {
        todosDirty = false;
        segmentDerivedChanged = true;
        todos =
          state.serverTodos.length > 0
            ? todosFromServer(state.serverTodos)
            : deriveTodos(todoSource);
      }

      const activityInputsChanged =
        previousState === undefined ||
        previousState.status !== state.status ||
        previousState.online !== state.online ||
        previousState.error !== state.error ||
        previousState.spinner !== state.spinner ||
        previousSegments[previousSegments.length - 1] !==
          state.segments[state.segments.length - 1] ||
        (changedIndex >= 0 &&
          (previousSegments
            .slice(changedIndex)
            .some((segment) => segment.type === "thinking") ||
            state.segments
              .slice(changedIndex)
              .some((segment) => segment.type === "thinking")));
      const nextActivity = activityInputsChanged
        ? deriveActivity(state)
        : activity;
      const activityChanged = !sameActivity(activity, nextActivity);
      if (activityChanged) activity = nextActivity;

      if (
        segmentDerivedChanged ||
        activityChanged ||
        previousState === undefined
      ) {
        result = {
          messages,
          tools,
          groups,
          groupsById,
          groupedSegments,
          visibleSegments,
          subtasks,
          todos,
          activity,
        };
      }
      previousState = state;
      previousSegments = state.segments;
      return result;
    },
  };
}
