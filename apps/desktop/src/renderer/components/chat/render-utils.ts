/**
 * Render utilities for local code chat: converts the conversation package's
 * canonical `Segment[]` into `ChatRenderItem[]` for React. Tool grouping,
 * sub-agent brackets and turn boundaries come from the package's derivations;
 * this file only shapes them for the desktop components.
 */
import { AgentStatus } from "#shared/agent-types";

import {
  deriveGroupedTranscript,
  type Segment,
  type SubtaskSummary,
  type ToolGroup,
  type ToolSegment,
} from "../../conversation";
import type { NotificationAction } from "../../conversation/agent-types";
import { extractTempImageRefs } from "../../conversation/temp-image-refs";
import {
  isToolSegment,
  toToolRenderItem,
} from "../../conversation/tool-adapter";
import { extractUserFileRefs } from "../../conversation/user-file-refs";
import { computeFeedbackMessageIndices } from "./feedback-row";
import { visibleUserText } from "./injected-text";

// ─── Public render types ──────────────────────────────────────────────────────

export type ToolRenderState = "running" | "done" | "error";

export type ToolRenderItem = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: import("#shared/agent-types").ToolResult;
  state: ToolRenderState;
  liveOutput?: string;
  displayData?: import("#shared/agent-types").ToolDisplayData;
  streamingArgs: boolean;
};

/** Image the user attached to their own message, resolved to an on-disk path. */
export type UserImageAttachment = {
  fileName: string;
  absPath: string;
  hostRoot?: string;
  mimeType: string;
};

/** A non-image file the user attached, shown as a pill on the bubble. */
export type UserFileAttachment = {
  fileName: string;
  absPath: string;
};

export type AgentRenderItem =
  | { kind: "text"; id: string; content: string; streaming: boolean }
  | {
      kind: "thinking";
      id: string;
      content: string;
      title?: string;
      streaming: boolean;
    }
  | {
      kind: "tool_group";
      id: string;
      tools: ToolRenderItem[];
      summary: string;
      state: ToolRenderState;
    }
  | {
      kind: "notification";
      id: string;
      message: string;
      severity: string;
      flashKey?: number;
      actions?: NotificationAction[];
    }
  | { kind: "credits"; id: string; creditsUsed: number }
  | {
      /** Per-turn feedback controls; credits ride along for the chip. */
      kind: "feedback";
      id: string;
      messageIndex: number;
      content: string;
      credits?: number;
    }
  | { kind: "subtask"; id: string; summary: SubtaskSummary }
  | { kind: "spinny"; id: string };

export type ChatRenderItem =
  | {
      kind: "user";
      id: string;
      text: string;
      images?: UserImageAttachment[];
      files?: UserFileAttachment[];
    }
  | { kind: "agent"; id: string; items: AgentRenderItem[] };

// ─── Tool group state ─────────────────────────────────────────────────────────

// ─── Segment → AgentRenderItem[] ─────────────────────────────────────────────

/**
 * Converts one turn's agent segments into AgentRenderItem[]; tool membership
 * comes from the conversation derivation. Thinking does not interrupt a tool
 * run (a turn should read as thought → work → answer): a thinking segment
 * neither flushes the tool buffer nor starts a second row after another one.
 */

function buildAgentItems(
  agentSegs: Segment[],
  subtasksByRef: Map<string, SubtaskSummary>,
  feedbackIndices: Map<string, number>,
  groupsById: ReadonlyMap<string, ToolGroup>,
  groupIdByMemberId: ReadonlyMap<string, string>,
  visibleSegmentIds: ReadonlySet<string>
): AgentRenderItem[] {
  const items: AgentRenderItem[] = [];
  let turnCredits: number | undefined;
  let creditsSegmentId: string | null = null;
  // The turn's last bot text — where the feedback row attaches.
  let feedbackText: {
    id: string;
    messageIndex: number;
    content: string;
  } | null = null;

  const pushThinking = (
    id: string,
    content: string,
    title: string | undefined,
    streaming: boolean
  ): void => {
    const last = items[items.length - 1];
    if (last?.kind === "thinking") {
      last.content =
        last.content.length > 0 ? `${last.content}\n\n${content}` : content;
      last.streaming = streaming;
      if (last.title == null && title != null) last.title = title;
      return;
    }
    items.push({
      kind: "thinking",
      id,
      content,
      ...(title != null ? { title } : {}),
      streaming,
    });
  };

  for (const seg of agentSegs) {
    const derivedGroupId = groupIdByMemberId.get(seg.id);
    if (derivedGroupId !== undefined) {
      const group = groupsById.get(derivedGroupId);
      if (group?.memberIds[0] !== seg.id) continue;

      const memberIds = new Set(group.memberIds);
      const tools = agentSegs
        .filter(
          (member): member is ToolSegment =>
            memberIds.has(member.id) && isToolSegment(member)
        )
        .map(toToolRenderItem);
      if (tools.length > 0) {
        items.push({
          kind: "tool_group",
          id: group.id,
          tools,
          summary: group.summary,
          state:
            group.status === "executing"
              ? "running"
              : group.status === "error"
                ? "error"
                : "done",
        });
      }
      continue;
    }

    if (isToolSegment(seg)) {
      // A newer lifecycle marker for this call replaced this segment in the
      // conversation derivation.
      if (!visibleSegmentIds.has(seg.id)) continue;
      const tool = toToolRenderItem(seg);
      items.push({
        kind: "tool_group",
        id: `tool-group:${tool.id}`,
        tools: [tool],
        summary: tool.name,
        state: tool.state,
      });
      continue;
    }

    switch (seg.type) {
      case "text": {
        items.push({
          kind: "text",
          id: seg.id,
          content: seg.content,
          streaming: seg.status === "transient",
        });
        const messageIndex = feedbackIndices.get(seg.id);
        if (messageIndex !== undefined) {
          feedbackText = { id: seg.id, messageIndex, content: seg.content };
        }
        break;
      }
      case "thinking":
        pushThinking(seg.id, seg.content, seg.title ?? undefined, seg.isSpinny);
        break;
      case "collapsible":
        // Transient spinner placeholders belong in the status line, not the
        // transcript; a settled collapsible renders as a thinking block.
        if (seg.temp === true || seg.isSpinny) {
          items.push({ kind: "spinny", id: seg.id });
        } else {
          pushThinking(seg.id, seg.content, seg.title ?? undefined, false);
        }
        break;
      case "notification":
        items.push({
          kind: "notification",
          id: seg.id,
          message: seg.message,
          severity: seg.severity,
          ...(seg.flashKey != null ? { flashKey: seg.flashKey } : {}),
          ...(seg.actions != null ? { actions: seg.actions } : {}),
        });
        break;
      case "credits":
        // Held back — folded into this turn's feedback row below so both sit on
        // one line. Emitted standalone only when the turn has no feedback row.
        turnCredits = (turnCredits ?? 0) + seg.creditsUsed;
        creditsSegmentId = seg.id;
        break;
      case "subtask": {
        const summary = subtasksByRef.get(seg.subtaskRef);
        if (summary != null)
          items.push({ kind: "subtask", id: seg.id, summary });
        break;
      }
      case "feature_limit":
        items.push({
          kind: "notification",
          id: seg.id,
          message: `${seg.featureName} limit reached (${seg.limitType})`,
          severity: "warning",
        });
        break;
      case "compaction":
        items.push({
          kind: "thinking",
          id: seg.id,
          content: seg.compactionSummary,
          title: "Compacted earlier context",
          streaming: false,
        });
        break;
    }
  }
  if (feedbackText != null) {
    items.push({
      kind: "feedback",
      id: `feedback-${feedbackText.id}`,
      messageIndex: feedbackText.messageIndex,
      content: feedbackText.content,
      ...(turnCredits != null ? { credits: turnCredits } : {}),
    });
  } else if (turnCredits != null && creditsSegmentId != null) {
    items.push({
      kind: "credits",
      id: creditsSegmentId,
      creditsUsed: turnCredits,
    });
  }
  return items;
}

// ─── Main builder ─────────────────────────────────────────────────────────────

/**
 * Builds chat render items from the canonical transcript; user segments are
 * the turn boundaries. `segments` should already be scoped (see
 * `scopeSegments`) so sub-agent children sit behind their card.
 */
export function buildChatItems(
  segments: Segment[],
  subtasks: SubtaskSummary[]
): ChatRenderItem[] {
  const subtasksByRef = new Map(subtasks.map((s) => [s.id, s]));
  const feedbackIndices = computeFeedbackMessageIndices(segments);
  const grouping = deriveGroupedTranscript(segments);
  const groupsById = new Map(grouping.groups.map((group) => [group.id, group]));
  const groupIdByMemberId = new Map<string, string>();
  const visibleSegmentIds = new Set<string>();
  for (const group of grouping.groups) {
    for (const memberId of group.memberIds) {
      groupIdByMemberId.set(memberId, group.id);
      visibleSegmentIds.add(memberId);
    }
  }
  for (const entry of grouping.groupedSegments) {
    if (entry.kind === "segment") visibleSegmentIds.add(entry.segmentId);
  }
  const result: ChatRenderItem[] = [];
  let agentBuffer: Segment[] = [];
  let agentTurnIdx = 0;

  const flushAgent = (): void => {
    if (agentBuffer.length === 0) return;
    const items = buildAgentItems(
      agentBuffer,
      subtasksByRef,
      feedbackIndices,
      groupsById,
      groupIdByMemberId,
      visibleSegmentIds
    );
    if (items.length > 0) {
      result.push({ kind: "agent", id: `agent-turn-${agentTurnIdx++}`, items });
    }
    agentBuffer = [];
  };

  for (const seg of segments) {
    if (seg.type === "text" && seg.source === "user") {
      flushAgent();
      const images = extractTempImageRefs(seg.content);
      const { files, text } = extractUserFileRefs(visibleUserText(seg.content));
      // The app talking to itself — a routine fire, an environment notice — is
      // not a message the reader sent, so it gets no bubble.
      if (text.length === 0 && images.length === 0 && files.length === 0)
        continue;
      result.push({
        kind: "user",
        id: seg.id,
        text,
        ...(images.length > 0 ? { images } : {}),
        ...(files.length > 0 ? { files } : {}),
      });
    } else {
      agentBuffer.push(seg);
    }
  }
  flushAgent();

  return result;
}

// ─── Deliverable filenames in prose ───────────────────────────────────────────

/** Document kinds worth linking: the deliverable, not every `.ts` named. */
const LINKABLE_EXTENSIONS = new Set([
  "pdf",
  "pptx",
  "ppt",
  "md",
  "html",
  "htm",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "csv",
  "docx",
  "xlsx",
  "txt",
  "json",
]);

/**
 * Regions of markdown left exactly as written: fenced blocks, inline code,
 * existing links and images, and raw HTML.
 */
const PROTECTED_MARKDOWN_RE =
  /```[\s\S]*?```|`[^`]*`|!?\[[^\]]*\]\([^)]*\)|<[^>]+>/g;

const escapeForRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// pathToFileURL is main-process only, so its shape is mirrored by hand: a
// Windows path needs its backslashes flipped and a slash before the drive,
// or `C:` parses as the URL's authority.
const toFileUrl = (absPath: string): string => {
  const slashed = absPath.replace(/\\/g, "/");
  const rooted = slashed.startsWith("/") ? slashed : `/${slashed}`;

  return `file://${encodeURI(rooted).replace(/#/g, "%23")}`;
};

/**
 * Turn bare deliverable filenames in prose into links to the file on disk. A
 * name is linked ONLY when this session already recorded an artifact with
 * exactly that filename, so every link points at a file that was written.
 */

export function linkifyKnownFiles(
  content: string,
  filesByName: Map<string, string>
): string {
  if (filesByName.size === 0 || content.length === 0) return content;

  const names = [...filesByName.keys()]
    .filter((name) => {
      const dot = name.lastIndexOf(".");
      return (
        dot > 0 && LINKABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
      );
    })
    // Longest first so `report final.pdf` wins over a shorter contained name.
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return content;

  // Not preceded by a path separator (that is already a path, handled above) or
  // by a word character, and not followed by one.
  const nameRe = new RegExp(
    `(^|[^\\w/\\\\.-])(${names.map(escapeForRegex).join("|")})(?![\\w/\\\\-])`,
    "g"
  );

  const rewrite = (chunk: string): string =>
    chunk.replace(nameRe, (match, prefix: string, name: string) => {
      const absPath = filesByName.get(name);
      return absPath == null
        ? match
        : `${prefix}[${name}](${toFileUrl(absPath)})`;
    });

  let out = "";
  let cursor = 0;
  PROTECTED_MARKDOWN_RE.lastIndex = 0;
  for (
    let m = PROTECTED_MARKDOWN_RE.exec(content);
    m != null;
    m = PROTECTED_MARKDOWN_RE.exec(content)
  ) {
    out += rewrite(content.slice(cursor, m.index)) + m[0];
    cursor = m.index + m[0].length;
  }
  return out + rewrite(content.slice(cursor));
}

// ─── Status label ─────────────────────────────────────────────────────────────

export function getAgentStatusLabel(
  status: AgentStatus,
  isRunning: boolean
): string | null {
  if (!isRunning) return null;
  switch (status) {
    case AgentStatus.Submitted:
      return "Thinking…";
    case AgentStatus.Streaming:
      return "Responding…";
    case AgentStatus.ExecutingTool:
      return "Running tool…";
    case AgentStatus.WaitingForToolPermission:
      return "Waiting for approval";
    case AgentStatus.LoadingConversation:
      return "Loading conversation…";
    default:
      return "Working…";
  }
}
