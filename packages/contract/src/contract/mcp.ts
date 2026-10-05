import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import type {
  AgentMcpLogEntry,
  AgentMcpServer,
  AgentMcpStatus,
  ImportMcpServersResult,
  McpOAuthSignInResult,
  McpRuntimeRequestResult,
  McpServerInfo,
} from "../contracts";
import { mutation, query, subscription } from "./base";
import { SessionId, WorkspaceId } from "./ids";

const McpModeSchema = v.literal("code");

export const McpServerEntrySchema = v.object({
  command: v.optional(v.string()),
  args: v.optional(v.array(v.string())),
  url: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
  headers: v.optional(v.record(v.string(), v.string())),
  oauth: v.optional(
    v.union([
      v.object({
        clientId: v.optional(v.string()),
        clientSecret: v.optional(v.string()),
        scope: v.optional(v.string()),
      }),
      v.literal(false),
    ])
  ),
  disabled: v.optional(v.boolean()),
  autoApprove: v.optional(v.array(v.string())),
  isBuiltin: v.optional(v.boolean()),
});

export const ListMcpServersRequestSchema = v.object({ mode: McpModeSchema });

const ServerName = v.pipe(v.string(), v.nonEmpty());

export const AddMcpServerRequestSchema = v.object({
  mode: McpModeSchema,
  name: ServerName,
  config: McpServerEntrySchema,
});

export const UpdateMcpServerRequestSchema = v.object({
  mode: McpModeSchema,
  name: ServerName,
  config: v.partial(McpServerEntrySchema),
});

export const RemoveMcpServerRequestSchema = v.object({
  mode: McpModeSchema,
  name: ServerName,
});

export const McpOAuthSignInRequestSchema = v.object({
  mode: McpModeSchema,
  name: ServerName,
});

export const SetMcpServerDisabledRequestSchema = v.object({
  mode: McpModeSchema,
  name: ServerName,
  disabled: v.boolean(),
});

export const ImportMcpServersRequestSchema = v.object({
  mode: McpModeSchema,
  source: v.picklist([
    "cursor",
    "claude",
    "abacusai-bot",
    "deepagent",
    "file",
    "json",
  ]),
  json: v.optional(v.string()),
});

export const McpSessionRequestSchema = v.object({
  workspaceId: WorkspaceId,
  sessionId: SessionId,
});

export const McpServerSessionRequestSchema = v.object({
  workspaceId: WorkspaceId,
  sessionId: SessionId,
  serverId: v.pipe(v.string(), v.nonEmpty()),
});

type McpRuntimeScope = { workspaceId: string; sessionId: string };

export type McpRuntimeEvent =
  | (McpRuntimeScope & { type: "servers"; servers: AgentMcpServer[] })
  | (McpRuntimeScope & {
      type: "status";
      serverId: string;
      status: AgentMcpStatus;
      error?: string;
      authUrl?: string;
      pid?: number;
      ts: string;
    })
  /** Lossless history lives in `mcp.runtime.logs`; this is the live tail. */
  | (McpRuntimeScope & { type: "log"; entry: AgentMcpLogEntry })
  | (McpRuntimeScope & { type: "refresh-failed"; error: string; ts: string })
  | (McpRuntimeScope & {
      type: "restart-failed";
      serverId: string;
      error: string;
      ts: string;
    });

type MutationResult = { success: boolean; error?: string };

export const mcp = {
  list: query
    .input(ListMcpServersRequestSchema)
    .output(type<McpServerInfo[]>()),
  add: mutation.input(AddMcpServerRequestSchema).output(type<MutationResult>()),
  update: mutation
    .input(UpdateMcpServerRequestSchema)
    .output(type<MutationResult>()),
  remove: mutation
    .input(RemoveMcpServerRequestSchema)
    .output(type<MutationResult>()),
  setDisabled: mutation
    .input(SetMcpServerDisabledRequestSchema)
    .output(type<MutationResult>()),
  import: mutation
    .input(ImportMcpServersRequestSchema)
    .output(type<ImportMcpServersResult>()),
  refresh: mutation
    .input(McpSessionRequestSchema)
    .output(type<McpRuntimeRequestResult>()),
  restart: mutation
    .input(McpServerSessionRequestSchema)
    .output(type<McpRuntimeRequestResult>()),
  /** Resolves when tokens are stored; the user closing the flow is `cancelled`. */
  oauthSignIn: mutation
    .input(McpOAuthSignInRequestSchema)
    .output(type<McpOAuthSignInResult>()),
  runtime: {
    servers: query
      .input(McpSessionRequestSchema)
      .output(type<AgentMcpServer[]>()),
    logs: query
      .input(McpServerSessionRequestSchema)
      .output(type<AgentMcpLogEntry[]>()),
    /** One session's live MCP state, or every session's without a filter. */
    events: subscription
      .input(v.optional(v.object({ sessionId: v.optional(SessionId) })))
      .output(eventIterator(type<McpRuntimeEvent>())),
  },
};
