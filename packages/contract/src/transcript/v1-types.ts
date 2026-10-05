/**
 * The v1 transcript file (`~/.abacusai-bot/transcripts/<sessionId>.json`) as
 * the old renderer writes it (spec 00 C.3). Type-only and vendored: the
 * segment shapes are `ConversationSegment` from
 * `renderer/conversation/agent-types.ts`, which `shared/` cannot import, plus
 * the file-format extras the renderer adds on the way to disk:
 *
 * - `at` (epoch ms) on every segment saved after `persistence.ts` began
 *   stamping it;
 * - the sub-agent bracket frames' `kind`, `startTime`, `endTime` and
 *   `outcome` (`serialization.ts`).
 *
 * The mapper reads every field defensively: a file on disk may predate any of
 * these shapes, or hold the agent protocol's older `tool_call` shape
 * (`toolUseRequest`/`toolUseResult`, `packages/agent/src/protocol.ts`).
 */

export type V1ToolCallStatus =
  | "pending"
  | "executing"
  | "awaiting_permission"
  | "success"
  | "error"
  | "rejected"
  | "interrupted"
  | "skipped"
  | "abandoned";

export interface V1ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: V1ToolCallStatus;
  endpoint?: string;
}

export type { V1ToolResult } from "./tool-result";
import type { V1ToolResult } from "./tool-result";

export interface V1NotificationAction {
  type: string;
  link?: string;
  model?: string;
  label?: string;
}

export interface V1SegmentVersions {
  current: number;
  total: number;
  siblings: { messageIndex: number; regenerateAttempt: number }[];
}

export interface V1WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
  thumbnailUrl?: string;
}

export type V1GeneratedMedia =
  | {
      kind: "image";
      url: string;
      width: number;
      height: number;
      prompt?: string;
      model?: string;
    }
  | {
      kind: "video";
      url: string;
      width: number;
      height: number;
      prompt?: string;
      model?: string;
      aspectRatio?: string;
      duration?: number;
      loop: boolean;
    };

/** Every segment may carry `at` (epoch ms). */
interface Stamped {
  at?: number;
}

export type V1Segment = Stamped &
  (
    | {
        type: "text";
        id: string;
        source: "user" | "bot";
        content: string;
        messageIndex?: number;
        regenerateAttempt?: number;
        versions?: V1SegmentVersions;
      }
    | {
        type: "thinking";
        id: string;
        content: string;
        title?: string;
        isSpinny: boolean;
      }
    | {
        type: "collapsible";
        id: string;
        title?: string;
        content: string;
        isSpinny: boolean;
      }
    | {
        type: "tool_call";
        id: string;
        toolCall: V1ToolCall;
        toolResult?: V1ToolResult;
      }
    | {
        type: "notification";
        id: string;
        message: string;
        severity: "info" | "warning" | "error" | "success";
        actions?: V1NotificationAction[];
        notificationKey?: string;
      }
    | {
        type: "tool_group";
        id: string;
        tools: V1Segment[];
        category: string;
        summary: string;
      }
    | { type: "credits"; id: string; creditsUsed: number }
    | {
        type: "web_search_results";
        id: string;
        query: string;
        resultType: "web" | "image";
        results: V1WebSearchResult[];
      }
    | { type: "media"; id: string; media: V1GeneratedMedia }
    | {
        type: "feature_limit";
        id: string;
        featureName: string;
        limitType: string;
      }
    | { type: "compaction"; id: string; summary: string }
    | {
        type: "subtask";
        id: string;
        status: "created" | "completed";
        description?: string;
        kind?: "component" | "delegate" | "browser";
        startTime?: number;
        endTime?: number;
        outcome?: "completed" | "interrupted";
      }
  );

/** The v1 file (`transcript-service.ts` `StoredTranscript`). */
export interface TranscriptFileV1 {
  version: 1;
  sessionId: string;
  updatedAt: string;
  segments: unknown[];
}
