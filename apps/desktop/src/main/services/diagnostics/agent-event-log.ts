/**
 * One log line per diagnostic fact in the agent's event stream: which model,
 * which tool and arguments, what the provider said, which call was refused
 * and why. Streamed text and thinking are absent: that is the transcript,
 * and it is the user's.
 */
import type {
  AgentEvent,
  DesktopEvent,
  ToolRequest,
} from "#shared/agent-types";

/** Never let one long argument push everything else off the line. */
const clip = (value: string, max = 200): string =>
  value.length <= max ? value : `${value.slice(0, max)}…`;

/** Which file or command, never the contents: those are the user's work. */
const describeTool = (tool: ToolRequest): string => {
  const input = tool.input ?? tool.args ?? {};
  const interesting = ["path", "file_path", "command", "url", "pattern", "cwd"];
  const parts: string[] = [];

  for (const key of interesting) {
    const value = input[key];

    if (typeof value === "string" && value.length > 0) {
      parts.push(`${key}=${clip(value, 160)}`);
    }
  }

  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
};

/**
 * The message out of an error payload, whichever field the model used, and
 * behind it what the provider itself said. The app's reading of a failure is
 * what the user reports; the provider's own sentence is what makes it
 * diagnosable, and it appears nowhere else.
 */
const errorText = (error: {
  message?: string;
  code?: string;
  name?: string;
  detail?: string;
  segmentData?: { message?: string };
}): string => {
  const message = clip(
    error.message ?? error.segmentData?.message ?? error.name ?? "(no message)",
    400
  );

  return error.detail == null
    ? message
    : `${message} :: provider said: ${clip(error.detail, 400)}`;
};

/**
 * Sessions that have seen a prompt cache hit. A later zero cache read on a
 * non-trivial request means the prefix changed, otherwise invisible.
 */
const cacheHitsSeen = new Set<string>();

/** A request small enough that a cache miss means nothing. */
const CACHE_WATCH_MIN_INPUT = 2_000;

const describeTurnComplete = (
  sessionId: string,
  usage: Extract<AgentEvent, { type: "turn_complete" }>["usage"]
): string => {
  if (usage == null) return "turn complete";
  const total = usage.input + usage.cacheRead;
  const line =
    `turn complete · cache read ${usage.cacheRead} write ${usage.cacheWrite} ` +
    `input ${usage.input} output ${usage.output}` +
    (usage.requests > 1 ? ` (${usage.requests} requests)` : "") +
    (usage.model != null ? ` ${usage.model}` : "");
  if (usage.cacheRead > 0) {
    cacheHitsSeen.add(sessionId);
    return line;
  }
  if (cacheHitsSeen.has(sessionId) && total >= CACHE_WATCH_MIN_INPUT)
    return `${line}; PROMPT CACHE MISS after hits: the cached prefix changed`;
  return line;
};

/** For tests: forget which sessions have hit the cache. */
export const resetCacheWatch = (): void => {
  cacheHitsSeen.clear();
};

const fromLoopEvent = (event: AgentEvent, sessionId: string): string | null => {
  switch (event.type) {
    case "model_changed":
      return `model=${event.model}`;

    case "mode_changed":
      return `mode=${event.mode}`;

    case "notification":
      return `notification[${event.severity}] ${clip(event.message, 400)}`;

    case "error":
      return `error${event.error.code != null ? `[${event.error.code}]` : ""} ${errorText(event.error)}`;

    case "retry":
      return `retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms${event.isNetworkError ? " (network)" : ""}`;

    case "tool_execution_start":
      return `tool start ${event.tool.name}#${event.tool.id}${describeTool(event.tool)}`;

    case "tool_execution_complete":
      // A tool that refused explains itself in `content` and nowhere else.
      return event.result.rejected === true
        ? `tool FAILED ${event.tool.name}#${event.tool.id}${describeTool(event.tool)} :: ${clip(event.result.content, 600)}`
        : `tool ok ${event.tool.name}#${event.tool.id}`;

    case "permission_needed":
      return `permission asked ${event.tool.type} ${event.tool.name}${describeTool(event.tool)}`;

    case "permission_cleared":
      return `permission cleared ${event.permissionId}`;

    case "subtask_start":
      return `subtask start ${event.id}${event.description != null ? ` ${clip(event.description, 120)}` : ""}`;

    case "subtask_end":
      return `subtask end ${event.id} ${event.status ?? "completed"}`;

    case "network_status":
      return `network ${event.online ? "online" : "offline"}`;

    case "turn_complete":
      return describeTurnComplete(sessionId, event.usage);

    default:
      // Transcript (text, thinking, deltas) or UI chatter.
      return null;
  }
};

/** Null for events that are transcript rather than diagnosis. */
export function describeAgentEvent(
  sessionId: string,
  event: DesktopEvent
): string | null {
  const prefix = `[${sessionId.slice(0, 8)}]`;

  if (event.type === "ready") {
    return `${prefix} ready model=${event.model} mode=${event.mode}`;
  }

  if (event.type === "mcp_server_status") {
    return `${prefix} mcp ${event.serverId} ${event.status}${event.error != null ? ` error=${clip(event.error, 300)}` : ""}`;
  }

  if (event.type === "mcp_refresh_failed") {
    return `${prefix} mcp refresh failed: ${clip(event.error, 300)}`;
  }

  if (event.type === "mcp_restart_failed") {
    return `${prefix} mcp restart failed ${event.serverId}: ${clip(event.error, 300)}`;
  }

  if (event.type !== "event") return null;

  const described = fromLoopEvent(event.event, sessionId);

  return described == null ? null : `${prefix} ${described}`;
}
