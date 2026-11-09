/**
 * The hosted computer sets this on every agent it starts: "off" when the plan
 * doesn't allow local tools (local MCP servers, extensions), "on" otherwise.
 */
export const HOSTED_LOCAL_TOOLS_ENV = "ABACUSAI_BOT_HOSTED_LOCAL_TOOLS";

/** Started by the hosted computer, which always hands over its own server list. */
export const startedByHostedComputer = (
  env: NodeJS.ProcessEnv = process.env
): boolean => env[HOSTED_LOCAL_TOOLS_ENV] != null;

/**
 * Whether code named in user-writable config may run: extensions and settings
 * packages from disk, and `!command` values in auth, model or provider config.
 */
export const userConfigCodeAllowed = (
  env: NodeJS.ProcessEnv = process.env
): boolean => env[HOSTED_LOCAL_TOOLS_ENV] !== "off";
