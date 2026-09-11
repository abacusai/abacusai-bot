/**
 * The tools the user switched off in Capabilities. Its own module because every
 * session in this process must honour it, sub-agents included; otherwise a
 * delegated sub-agent gets a working `bash` with the shell off. The list is
 * resolved in the main process and passed in the environment, since this
 * package cannot import from `src/shared`.
 */

/**
 * pi's tool name -> the name the desktop's tool renderer switches on. Dropping
 * the MCP server prefix is safe: every consumer matches
 * `name === base || name.endsWith('_base')` and the gate's names don't collide.
 */
export const TOOL_NAME_ALIASES: Record<string, string> = {
  find: "glob",
  "agent-tools_pdf": "pdf",
  "agent-tools_app": "app",
};

/** Names arrive as the desktop spells them; `glob` maps back to pi's `find`. */
export function excludedTools(): string[] {
  const raw = process.env.ABACUSAI_BOT_EXCLUDED_TOOLS ?? "";
  const toPiName = new Map(
    Object.entries(TOOL_NAME_ALIASES).map(([piName, display]) => [
      display,
      piName,
    ])
  );

  return raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => toPiName.get(name) ?? name);
}
