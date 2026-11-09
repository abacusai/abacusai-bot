/**
 * The hosted computer sets this on every agent it starts: "off" when the plan
 * doesn't allow local tools (local MCP servers, extensions), "on" otherwise.
 */
export const HOSTED_LOCAL_TOOLS_ENV = "ABACUSAI_BOT_HOSTED_LOCAL_TOOLS";

/** Started by the hosted computer, which always hands over its own server list. */
export const startedByHostedComputer = (
  env: NodeJS.ProcessEnv = process.env
): boolean => env[HOSTED_LOCAL_TOOLS_ENV] != null;

/** Whether extensions from disk (agent dir, project, settings packages) may load. */
export const diskExtensionsAllowed = (
  env: NodeJS.ProcessEnv = process.env
): boolean => env[HOSTED_LOCAL_TOOLS_ENV] !== "off";
