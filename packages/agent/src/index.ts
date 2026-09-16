/**
 * `@abacus-ai/agent` — the agent as a library. `./main.js` is the same session
 * as a child process, wrapped in the NDJSON protocol.
 */
export { bundledToolsDir, useBundledTools } from "./bundled-tools.js";
export {
  BUSYBOX_VERSION,
  installPosixShell,
  posixShell,
  posixShellOperations,
  windowsShellPrompt,
} from "./posix-shell.js";
export type { PosixShell } from "./posix-shell.js";
export {
  MAX_CUSTOM_INSTRUCTIONS,
  customInstructionsPath,
  readCustomInstructions,
  writeCustomInstructions,
} from "./custom-instructions.js";
export {
  DEFAULT_MODEL,
  PROVIDER_DEFAULTS,
  abacusBotDir,
  accountPath,
  agentDir,
  applyStoredApiKeys,
  configPath,
  defaultModelFor,
  desktopMcpConfigPath,
  loadConfig,
  saveConfig,
  skillDirs,
  skillDirsByScope,
  userProfilePrompt,
} from "./config.js";
export type {
  AbacusBotConfig,
  CustomProviderConfig,
  CustomProviderModel,
} from "./config.js";
export { TOOL_NAME_ALIASES, excludedTools } from "./excluded-tools.js";
// openllm.ts is not exported: its signatures carry providers.ts types, which
// drag pi's whole declaration tree into the dts bundle and break the build.
export { NdjsonHost } from "./host.js";
export type { HostOptions } from "./host.js";
export {
  MODE_NAMES,
  gateToolCall,
  isMutatingCall,
  isMutatingTool,
  parseMode,
  parseModeStrict,
} from "./permissions.js";
export type { Gate, GateOptions } from "./permissions.js";
export * from "./protocol.js";
export { AbacusBotSession, mcpPrompt } from "./session.js";
export type { SessionOptions } from "./session.js";
export {
  HEARTBEAT_INTERVAL_MS,
  MAX_VOUCHED_RUNTIME_MS,
  ToolHeartbeat,
} from "./tool-heartbeat.js";
export {
  fetchOpenRouterKeyStatus,
  isOpenLlmPoolModel,
  UsageScanner,
} from "./usage-stats.js";
export type {
  ModelUsageStats,
  OpenRouterKeyStatus,
  UsageDay,
  UsageSummary,
  UsageTotals,
} from "./usage-stats.js";
