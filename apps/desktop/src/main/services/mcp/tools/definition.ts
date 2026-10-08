import type { ChannelCapabilities } from "@abacus-ai/agent/channel";
import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";

import type { McpAgentToolsServer } from "../mcp-agent-tools-server";
import type { McpToolResult } from "../mcp-http-server";

/** The SDK's result type; see McpToolResult. */
export type ToolResult = McpToolResult;

/**
 * The server's handlers a definition may call. A `Pick` of the server rather
 * than a second interface, so a handler's signature is written once.
 */
export type ToolHost = Pick<
  McpAgentToolsServer,
  | "skillsList"
  | "skillView"
  | "skillManage"
  | "todo"
  | "memory"
  | "cronjob"
  | "analyze"
  | "imageGenerate"
  | "textToSpeech"
  | "deckExportPdf"
  | "pdf"
  | "serve"
  | "presentDeliverable"
  | "pollVideoJob"
  | "submitVideoJob"
  | "xSearch"
  | "sendChatMessage"
  | "connectConnectorOutcome"
  | "disconnectConnectorOutcome"
  | "myActivity"
  | "listChats"
  | "readChatMessages"
  | "autoReply"
  | "homeAssistant"
  | "ok"
  | "err"
>;

/**
 * One tool, fully described: what the model sees, which Capabilities toggle
 * governs it, who may see it, and what runs. Listing and dispatch are derived
 * from this and nothing else (see ./index.ts).
 */
export interface ToolDefinition {
  name: string;
  /**
   * What the model reads. A function where the words depend on the chat
   * (a pane to open, a phone to send to), rendered for each caller's channel
   * when the tools are listed.
   */
  description: string | ((channel: ChannelCapabilities) => string);
  inputSchema:
    | Record<string, unknown>
    | ((channel: ChannelCapabilities) => Record<string, unknown>);
  /**
   * The Capabilities toggles that turn it on; any one on is enough, which
   * keeps `bfl_flux3_get_result` reachable beside every submitter that polls
   * it. `"always"` ignores the toggles: those are how the agent shows what
   * `write` or `bash` produced, and gating them left deliverables the user
   * found by path.
   */
  toolsets: readonly string[] | "always";
  /**
   * A bot gets it whatever the toggles say. `cronjob` defaults off for
   * sessions because unattended runs are reach nobody signed up for; a bot's
   * routines are asked for in its chat and listed under Routines.
   */
  botAlways?: boolean;
  /**
   * Only a bot may call it. Enforced by leaving it out of a session's tool
   * list rather than only refusing the call, so a session's model never sees
   * a tool it cannot use.
   */
  botsOnly?: boolean;
  /**
   * Never shown to the model: the cross-platform originals the per-platform
   * tools delegate to. Callable still, but one platform's contacts and
   * messages must never appear beside another's in one result.
   */
  hidden?: boolean;
  /** Listed only while this platform's connector runs. */
  platform?: MessagingPlatformId;
  /**
   * Whether the third-party credential it needs is set. Consulted only when
   * listing, so a toolset can be on by default and cost no prompt budget
   * until it works. `tools/call` does not check: a model holding an older
   * list should get the setup hint, not "unknown tool".
   */
  ready?: () => boolean;
  run: (
    host: ToolHost,
    args: Record<string, unknown>,
    callerSession?: string
  ) => ToolResult | Promise<ToolResult>;
}
