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
