/**
 * A-T1: the contract's types, checked by `tsc -b` under every project that
 * compiles `src/shared` (the renderer's is strict) and run by vitest.
 *
 * (a) Every input schema that mirrors a request type in shared/contracts.ts
 *     (and its siblings) infers exactly that type, in both directions, so the
 *     legacy type and the schema cannot drift.
 * (b) The client a renderer gets: a query resolves to its output, a stream to
 *     an async iterator of its events.
 * (c) `isDefinedError` narrows a defined error's data.
 */
import { isDefinedError } from "@orpc/client";
import type { ContractRouterClient, ErrorFromErrorMap } from "@orpc/contract";
import type { AsyncIteratorClass } from "@orpc/shared";
import type * as v from "valibot";
import { describe, expectTypeOf, it } from "vitest";

import type { BotChangeNotice, BotCreateInput, BotUpdateInput } from "../bots";
import type {
  AddMcpServerRequest,
  AgentPermissionResponseRequest,
  AgentQueueMessageRequest,
  AgentRemoveFromQueueRequest,
  AgentSessionCommandRequest,
  AgentSetModelRequest,
  AgentSetModeRequest,
  AgentSwitchConversationRequest,
  AgentUpdateQueueMessageRequest,
  BootLocalDeviceRequest,
  BrowserRuntimeLease,
  BuildAndRunLocalDeviceRequest,
  CaptureDeviceScreenshotRequest,
  ClearBrowserDataRequest,
  CreateLocalDeviceRequest,
  CreateWorktreeRequest,
  GetMcpRuntimeServersRequest,
  GetMcpServerLogsRequest,
  GetSimulatorWindowSourceRequest,
  HideBrowserRuntimeRequest,
  ImportMcpServersRequest,
  InteractLocalDeviceRequest,
  ListMcpServersRequest,
  ListWorktreesRequest,
  MaterializeBrowserRuntimeRequest,
  MaterializeSessionWorktreeRequest,
  McpOAuthSignInRequest,
  McpServerEntry,
  NavigateBrowserRuntimeRequest,
  NotificationSettings,
  PromoteBrowserRuntimeScopeRequest,
  PromoteTerminalSessionScopeRequest,
  RefreshMcpServersRequest,
  RemoveMcpServerRequest,
  ResizeTerminalSessionRequest,
  RespondBrowserPermissionRequest,
  RespondConnectorRequest,
  RestartMcpServerRequest,
  SetMcpServerDisabledRequest,
  SetSessionWorktreeRequest,
  StartAgentSessionRequest,
  StartDeviceStreamRequest,
  StartTerminalSessionRequest,
  StreamDeviceKeyRequest,
  StreamDeviceTouchRequest,
  TerminalRuntimeRequest,
  TurnFeedbackInput,
  UpdateMcpServerRequest,
  WorkspaceGitContext,
  WriteTerminalInputRequest,
  ListWorktreesResult,
  DeviceStreamChunk,
} from "../contracts";
import type {
  MessagingPairingDecisionRequest,
  UpdateMessagingPlatformRequest,
  UpdateMessagingSettingsRequest,
} from "../messaging";
import type { RoutineCreateInput, RoutineUpdateInput } from "../routines";
import type {
  ImportLocalSkillsRequest,
  InstallSkillRequest,
  ListInstalledSkillsRequest,
  OpenSkillFileRequest,
  RemoveSkillRequest,
  SearchMarketplaceSkillsRequest,
} from "../skills-types";
import type {
  AgentPermissionResponseRequestSchema,
  AgentQueueMessageRequestSchema,
  AgentRemoveFromQueueRequestSchema,
  AgentSessionCommandRequestSchema,
  AgentSetModelRequestSchema,
  AgentSetModeRequestSchema,
  AgentSwitchConversationRequestSchema,
  AgentUpdateQueueMessageRequestSchema,
  StartAgentSessionRequestSchema,
  TurnFeedbackInputSchema,
} from "./agent";
import type { BotChangeNoticeSchema } from "./bots";
import type {
  BrowserRuntimeLeaseSchema,
  ClearBrowserDataRequestSchema,
  HideBrowserRuntimeRequestSchema,
  MaterializeBrowserRuntimeRequestSchema,
  NavigateBrowserRuntimeRequestSchema,
  PromoteBrowserRuntimeScopeRequestSchema,
  RespondBrowserPermissionRequestSchema,
} from "./browser";
import type { RespondConnectorRequestSchema } from "./connectors";
import type {
  BotCreateInputSchema,
  BotUpdateInputSchema,
  PrefsPatchSchema,
  RoutineCreateInputSchema,
  RoutineUpdateInputSchema,
} from "./db";
import type {
  BootLocalDeviceRequestSchema,
  BuildAndRunLocalDeviceRequestSchema,
  CaptureDeviceScreenshotRequestSchema,
  CreateLocalDeviceRequestSchema,
  GetSimulatorWindowSourceRequestSchema,
  InteractLocalDeviceRequestSchema,
  StartDeviceStreamRequestSchema,
  StreamDeviceKeyRequestSchema,
  StreamDeviceTouchRequestSchema,
} from "./devices";
import type { COMMON_ERRORS, NotFoundEntity } from "./errors";
import type {
  CreateWorktreeRequestSchema,
  ListWorktreesRequestSchema,
  MaterializeSessionWorktreeRequestSchema,
  SetSessionWorktreeRequestSchema,
  WorkspaceGitContextSchema,
} from "./git";
import type { Contract } from "./index";
import type {
  AddMcpServerRequestSchema,
  ImportMcpServersRequestSchema,
  ListMcpServersRequestSchema,
  McpOAuthSignInRequestSchema,
  McpServerEntrySchema,
  McpServerSessionRequestSchema,
  McpSessionRequestSchema,
  RemoveMcpServerRequestSchema,
  SetMcpServerDisabledRequestSchema,
  UpdateMcpServerRequestSchema,
} from "./mcp";
import type {
  MessagingPairingDecisionRequestSchema,
  UpdateMessagingPlatformRequestSchema,
  UpdateMessagingSettingsRequestSchema,
} from "./messaging";
import type { PrefsPatch } from "./rows";
import type { NotificationSettingsSchema } from "./settings";
import type {
  ImportLocalSkillsRequestSchema,
  InstallSkillRequestSchema,
  ListInstalledSkillsRequestSchema,
  OpenSkillFileRequestSchema,
  RemoveSkillRequestSchema,
  SearchMarketplaceSkillsRequestSchema,
} from "./skills";
import type { SystemInfo } from "./system";
import type {
  PromoteTerminalSessionScopeRequestSchema,
  ResizeTerminalSessionRequestSchema,
  StartTerminalSessionRequestSchema,
  TerminalOutputChunk,
  TerminalRuntimeRequestSchema,
  WriteTerminalInputRequestSchema,
} from "./terminal";

/** True only when each type is assignable to the other. */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Mirrors<S extends v.GenericSchema, T> = Mutual<v.InferOutput<S>, T>;

describe("contract types (A-T1)", () => {
  it("(a) mirrors every legacy request type in both directions", () => {
    // The check can fail: a schema does not mirror a different request type.
    expectTypeOf<
      Mirrors<typeof ListWorktreesRequestSchema, CreateWorktreeRequest>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Mirrors<typeof RoutineCreateInputSchema, RoutineUpdateInput>
    >().toEqualTypeOf<false>();

    expectTypeOf<
      Mirrors<typeof ListWorktreesRequestSchema, ListWorktreesRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof CreateWorktreeRequestSchema, CreateWorktreeRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof SetSessionWorktreeRequestSchema, SetSessionWorktreeRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof MaterializeSessionWorktreeRequestSchema,
        MaterializeSessionWorktreeRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof WorkspaceGitContextSchema, WorkspaceGitContext>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof StartTerminalSessionRequestSchema,
        StartTerminalSessionRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof TerminalRuntimeRequestSchema, TerminalRuntimeRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof WriteTerminalInputRequestSchema, WriteTerminalInputRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof ResizeTerminalSessionRequestSchema,
        ResizeTerminalSessionRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof PromoteTerminalSessionScopeRequestSchema,
        PromoteTerminalSessionScopeRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof StartAgentSessionRequestSchema, StartAgentSessionRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof AgentSessionCommandRequestSchema,
        AgentSessionCommandRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof AgentSetModeRequestSchema, AgentSetModeRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof AgentSetModelRequestSchema, AgentSetModelRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof AgentPermissionResponseRequestSchema,
        AgentPermissionResponseRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof AgentSwitchConversationRequestSchema,
        AgentSwitchConversationRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof AgentQueueMessageRequestSchema, AgentQueueMessageRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof AgentRemoveFromQueueRequestSchema,
        AgentRemoveFromQueueRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof AgentUpdateQueueMessageRequestSchema,
        AgentUpdateQueueMessageRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof TurnFeedbackInputSchema, TurnFeedbackInput>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof CaptureDeviceScreenshotRequestSchema,
        CaptureDeviceScreenshotRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof BootLocalDeviceRequestSchema, BootLocalDeviceRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof CreateLocalDeviceRequestSchema, CreateLocalDeviceRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof InteractLocalDeviceRequestSchema,
        InteractLocalDeviceRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof BuildAndRunLocalDeviceRequestSchema,
        BuildAndRunLocalDeviceRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof StartDeviceStreamRequestSchema, StartDeviceStreamRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof StreamDeviceTouchRequestSchema, StreamDeviceTouchRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof StreamDeviceKeyRequestSchema, StreamDeviceKeyRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof GetSimulatorWindowSourceRequestSchema,
        GetSimulatorWindowSourceRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof RespondConnectorRequestSchema, RespondConnectorRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof RespondBrowserPermissionRequestSchema,
        RespondBrowserPermissionRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof ClearBrowserDataRequestSchema, ClearBrowserDataRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof McpServerEntrySchema, McpServerEntry>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof ListMcpServersRequestSchema, ListMcpServersRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof AddMcpServerRequestSchema, AddMcpServerRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof UpdateMcpServerRequestSchema, UpdateMcpServerRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof RemoveMcpServerRequestSchema, RemoveMcpServerRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof McpOAuthSignInRequestSchema, McpOAuthSignInRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof SetMcpServerDisabledRequestSchema,
        SetMcpServerDisabledRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof ImportMcpServersRequestSchema, ImportMcpServersRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof McpSessionRequestSchema, RefreshMcpServersRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof McpSessionRequestSchema, GetMcpRuntimeServersRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof McpServerSessionRequestSchema, RestartMcpServerRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof McpServerSessionRequestSchema, GetMcpServerLogsRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof MaterializeBrowserRuntimeRequestSchema,
        MaterializeBrowserRuntimeRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof HideBrowserRuntimeRequestSchema, HideBrowserRuntimeRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof NavigateBrowserRuntimeRequestSchema,
        NavigateBrowserRuntimeRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof PromoteBrowserRuntimeScopeRequestSchema,
        PromoteBrowserRuntimeScopeRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof BrowserRuntimeLeaseSchema, BrowserRuntimeLease>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof NotificationSettingsSchema, NotificationSettings>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof UpdateMessagingPlatformRequestSchema,
        UpdateMessagingPlatformRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof MessagingPairingDecisionRequestSchema,
        MessagingPairingDecisionRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof UpdateMessagingSettingsRequestSchema,
        UpdateMessagingSettingsRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof BotCreateInputSchema, BotCreateInput>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof BotUpdateInputSchema, BotUpdateInput>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof BotChangeNoticeSchema, BotChangeNotice>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof RoutineCreateInputSchema, RoutineCreateInput>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof RoutineUpdateInputSchema, RoutineUpdateInput>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof ListInstalledSkillsRequestSchema,
        ListInstalledSkillsRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<
        typeof SearchMarketplaceSkillsRequestSchema,
        SearchMarketplaceSkillsRequest
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof InstallSkillRequestSchema, InstallSkillRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof RemoveSkillRequestSchema, RemoveSkillRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof OpenSkillFileRequestSchema, OpenSkillFileRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof ImportLocalSkillsRequestSchema, ImportLocalSkillsRequest>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Mirrors<typeof PrefsPatchSchema, PrefsPatch>
    >().toEqualTypeOf<true>();
  });

  it("(b) gives the renderer a typed client", () => {
    type AppClient = ContractRouterClient<Contract>;

    // A query resolves to its output.
    expectTypeOf<ReturnType<AppClient["git"]["worktrees"]["list"]>>().toExtend<
      Promise<ListWorktreesResult>
    >();
    expectTypeOf<
      Awaited<ReturnType<AppClient["git"]["worktrees"]["list"]>>
    >().toEqualTypeOf<ListWorktreesResult>();
    expectTypeOf<
      Awaited<ReturnType<AppClient["system"]["info"]>>
    >().toEqualTypeOf<SystemInfo>();
    // A mutation with a void output resolves to void.
    expectTypeOf<
      Awaited<ReturnType<AppClient["workspaces"]["switch"]>>
    >().toEqualTypeOf<void>();
    // A stream resolves to an async iterator of its events.
    expectTypeOf<
      Awaited<ReturnType<AppClient["terminal"]["output"]>>
    >().toEqualTypeOf<AsyncIteratorClass<TerminalOutputChunk, unknown, void>>();
    expectTypeOf<
      Awaited<ReturnType<AppClient["devices"]["stream"]["chunks"]>>
    >().toEqualTypeOf<AsyncIteratorClass<DeviceStreamChunk, unknown, void>>();
    // Inputs are the named objects, never positional arguments.
    expectTypeOf<
      Parameters<AppClient["sessions"]["turnState"]>[0]
    >().toEqualTypeOf<{ workspaceId: string; sessionId: string }>();
  });

  it("(c) narrows a defined error's data", () => {
    const narrow = (error: ErrorFromErrorMap<typeof COMMON_ERRORS>): void => {
      if (isDefinedError(error) && error.code === "NOT_FOUND") {
        expectTypeOf(error.data.entity).toEqualTypeOf<NotFoundEntity>();
        expectTypeOf(error.data.id).toEqualTypeOf<string>();
      }
      if (isDefinedError(error) && error.code === "RESYNC_REQUIRED") {
        expectTypeOf(error.data.stream).toEqualTypeOf<string>();
      }
    };
    expectTypeOf(narrow).toBeFunction();
  });
});
