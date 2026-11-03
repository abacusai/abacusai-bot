/**
 * `@abacus-ai/agent/tool-display`: the renderer's tool title, kind and result
 * formatting, computed from the final input at render time (spec §3.3.5).
 *
 * Browser-safe on purpose: this entry and its closure import nothing from
 * `node:*` or pi (tool-display.test.ts enforces it), so the renderer's bundle
 * can take it without the agent's dependency graph.
 */
export {
  buildToolTitle,
  type ToolArgs,
} from "./agui/vendor/pi-acp/tool-title.js";
export { toToolKind, type ToolKind } from "./agui/vendor/pi-acp/tool-kind.js";
export {
  formatToolContent,
  wrapStreamingBashOutput,
} from "./agui/vendor/pi-acp/tool-content.js";

/** Longest tool summary worth carrying into a timeout message. */
const ACTIVITY_SUMMARY_MAX = 120;

/**
 * What a tool call is doing, short enough for an error banner, e.g.
 * `edit (server/app.js)`: what the turn watchdog names when an agent goes
 * quiet, from the call's start or the agent's heartbeat. A wedged turn is
 * diagnosed from this line alone: a tool that hangs before it starts emits
 * no card to persist.
 */
export const describeToolCall = (tool: {
  name?: unknown;
  input?: Record<string, unknown>;
  args?: Record<string, unknown>;
}): string | null => {
  const name =
    typeof tool.name === "string" && tool.name.length > 0 ? tool.name : null;
  if (name == null) return null;
  const input = tool.input ?? tool.args ?? {};
  const detail = input.command ?? input.path ?? input.url;
  if (typeof detail !== "string" || detail.length === 0) return name;
  const flat = detail.replace(/\s+/g, " ").trim();
  const clipped =
    flat.length > ACTIVITY_SUMMARY_MAX
      ? `${flat.slice(0, ACTIVITY_SUMMARY_MAX)}…`
      : flat;
  return `${name} (${clipped})`;
};
