import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import type {
  BrowserPermissionRequest,
  BrowserProfileInfo,
  BrowserRuntimeCapture,
  BrowserRuntimeLease,
  BrowserRuntimeState,
  ClearBrowserDataResult,
  ImportBrowserProfileResult,
  McpBrowserStatus,
} from "../contracts";
import type { ConversationKey } from "../conversation-scope";
import { mutation, query, subscription } from "./base";
import { ConversationKeySchema, NoInput } from "./ids";

export const BrowserRuntimeLeaseSchema = v.object({
  conversationKey: ConversationKeySchema,
  resourceId: v.pipe(v.string(), v.nonEmpty()),
  generation: v.number(),
});

export const BrowserRuntimeBoundsSchema = v.object({
  x: v.number(),
  y: v.number(),
  width: v.number(),
  height: v.number(),
});

export const MaterializeBrowserRuntimeRequestSchema = v.object({
  conversationKey: ConversationKeySchema,
  resourceId: v.pipe(v.string(), v.nonEmpty()),
  profileId: v.optional(v.string()),
  url: v.optional(v.string()),
});

/**
 * A local PDF or HTML file on the native surface (spec 04 §12.8): checked
 * with `files.readText`'s containment guard (`filePath` inside `hostRoot`,
 * symlinks resolved), `pdf`/`html`/`htm`, a regular file. The view is locked
 * to that file; `navigate {url}` on it is `FORBIDDEN {reason: "local-file"}`.
 */
export const MaterializeBrowserRuntimeFileRequestSchema = v.object({
  conversationKey: ConversationKeySchema,
  resourceId: v.pipe(v.string(), v.nonEmpty()),
  filePath: v.pipe(v.string(), v.nonEmpty()),
  hostRoot: v.pipe(v.string(), v.nonEmpty()),
});

export type MaterializeBrowserRuntimeFileRequest = v.InferOutput<
  typeof MaterializeBrowserRuntimeFileRequestSchema
>;

export const PresentBrowserRuntimeRequestSchema = v.object({
  lease: BrowserRuntimeLeaseSchema,
  presentationId: v.pipe(v.string(), v.nonEmpty()),
  bounds: BrowserRuntimeBoundsSchema,
  url: v.optional(v.string()),
});

export const HideBrowserRuntimeRequestSchema = v.object({
  lease: BrowserRuntimeLeaseSchema,
  presentationId: v.pipe(v.string(), v.nonEmpty()),
});

export const BrowserRuntimeNavigationSchema = v.union([
  v.object({ action: v.literal("url"), url: v.string() }),
  v.object({
    action: v.picklist([
      "back",
      "forward",
      "reload",
      "hard-reload",
      "stop",
      "focus",
      "open-devtools",
      "zoom-in",
      "zoom-out",
      "zoom-reset",
      "clear-site-data",
    ]),
  }),
]);

export const NavigateBrowserRuntimeRequestSchema = v.object({
  lease: BrowserRuntimeLeaseSchema,
  navigation: BrowserRuntimeNavigationSchema,
});

export const PromoteBrowserRuntimeScopeRequestSchema = v.object({
  draftConversationKey: ConversationKeySchema,
  sessionConversationKey: ConversationKeySchema,
});

export const RespondBrowserPermissionRequestSchema = v.object({
  requestId: v.pipe(v.string(), v.nonEmpty()),
  conversationKey: ConversationKeySchema,
  decision: v.picklist(["allow", "deny", "session", "always"]),
});

export const ClearBrowserDataRequestSchema = v.object({
  partition: v.optional(v.string()),
});

export const BrowserApprovalSchema = v.picklist(["ask", "always"]);

export type BrowserEvent =
  /** First yield on (re)open: the permission asks still pending here. */
  | { type: "snapshot"; permissionRequests: BrowserPermissionRequest[] }
  | { type: "permission-request"; request: BrowserPermissionRequest }
  | { type: "permission-cleared"; requestId: string }
  | { type: "open-preview"; url?: string; conversationKey?: ConversationKey }
  | {
      type: "runtime-materialized";
      conversationKey: ConversationKey;
      resourceId: string;
      url: string;
    }
  /** High rate and coalesced: only the latest cursor state is kept. */
  | {
      type: "cursor";
      action: "move" | "click" | "hide";
      x?: number;
      y?: number;
    }
  | { type: "status"; status: McpBrowserStatus }
  | { type: "runtime-state"; state: BrowserRuntimeState };

export const browser = {
  profiles: {
    list: query.input(NoInput).output(type<BrowserProfileInfo[]>()),
    import: mutation
      .input(v.object({ profileId: v.pipe(v.string(), v.nonEmpty()) }))
      .output(type<ImportBrowserProfileResult>()),
  },
  /** Restricted to the main renderer, as the legacy channels are. */
  runtime: {
    materialize: mutation
      .input(MaterializeBrowserRuntimeRequestSchema)
      .output(type<BrowserRuntimeState>()),
    materializeFile: mutation
      .input(MaterializeBrowserRuntimeFileRequestSchema)
      .output(type<BrowserRuntimeState>()),
    present: mutation
      .input(PresentBrowserRuntimeRequestSchema)
      .output(type<BrowserRuntimeState>()),
    navigate: mutation
      .input(NavigateBrowserRuntimeRequestSchema)
      .output(type<BrowserRuntimeState>()),
    capture: mutation
      .input(BrowserRuntimeLeaseSchema)
      .output(type<BrowserRuntimeCapture>()),
    hide: mutation.input(HideBrowserRuntimeRequestSchema).output(type<void>()),
    close: mutation.input(BrowserRuntimeLeaseSchema).output(type<void>()),
    promoteScope: mutation
      .input(PromoteBrowserRuntimeScopeRequestSchema)
      .output(type<BrowserRuntimeLease[]>()),
  },
  setEngine: mutation
    .input(v.object({ engine: v.picklist(["builtin", "chrome"]) }))
    .output(type<McpBrowserStatus>()),
  chrome: {
    /** Opens Chrome's allow page and waits for the user (or the token). */
    connect: mutation.input(NoInput).output(type<McpBrowserStatus>()),
    disconnect: mutation.input(NoInput).output(type<McpBrowserStatus>()),
    setExtensionToken: mutation
      .input(v.object({ token: v.string() }))
      .output(type<McpBrowserStatus>()),
  },
  status: query.input(NoInput).output(type<McpBrowserStatus>()),
  setEnabled: mutation
    .input(v.object({ enabled: v.boolean() }))
    .output(type<McpBrowserStatus>()),
  permissions: {
    list: query
      .input(v.object({ conversationKey: ConversationKeySchema }))
      .output(type<BrowserPermissionRequest[]>()),
    setApproval: mutation
      .input(v.object({ approval: BrowserApprovalSchema }))
      .output(type<McpBrowserStatus>()),
    respond: mutation
      .input(RespondBrowserPermissionRequestSchema)
      .output(type<void>()),
  },
  clearData: mutation
    .input(v.optional(ClearBrowserDataRequestSchema))
    .output(type<ClearBrowserDataResult>()),
  /**
   * Permission asks, previews and materialized runtimes are delivered
   * losslessly; cursor, status and runtime state are coalesced. With a
   * `conversationKey` the conversation-scoped events are filtered to it and the
   * first yield snapshots its pending asks.
   */
  events: subscription
    .input(
      v.optional(
        v.object({ conversationKey: v.optional(ConversationKeySchema) })
      )
    )
    .output(eventIterator(type<BrowserEvent>())),
};
