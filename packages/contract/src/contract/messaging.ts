import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import {
  MESSAGING_PLATFORM_IDS,
  SHARED_LINK_TARGETS,
  type MessagingPlatformId,
  type MessagingSnapshot,
} from "../messaging";
import { mutation, query, subscription } from "./base";
import { BotId, NoInput, WorkspaceId } from "./ids";

export const MessagingPlatformIdSchema = v.picklist(
  MESSAGING_PLATFORM_IDS as unknown as MessagingPlatformId[]
);

export const UpdateMessagingPlatformRequestSchema = v.object({
  platformId: MessagingPlatformIdSchema,
  enabled: v.optional(v.boolean()),
  values: v.optional(v.record(v.string(), v.string())),
});

export const MessagingPairingDecisionRequestSchema = v.object({
  platformId: MessagingPlatformIdSchema,
  userId: v.pipe(v.string(), v.nonEmpty()),
  decision: v.picklist(["approve", "revoke", "pause", "resume"]),
});

export const UpdateMessagingSettingsRequestSchema = v.object({
  gatewayEnabled: v.optional(v.boolean()),
  autoApproveTools: v.optional(v.boolean()),
  respondToInbound: v.optional(v.boolean()),
  workspaceId: v.optional(v.nullable(WorkspaceId)),
  botId: v.optional(v.nullable(BotId)),
});

const PlatformInput = v.object({ platformId: MessagingPlatformIdSchema });

/** Coarse on purpose: the pane re-reads the whole snapshot. */
export type MessagingEvent = { type: "updated" };

export const messaging = {
  snapshot: query.input(NoInput).output(type<MessagingSnapshot>()),
  updatePlatform: mutation
    .input(UpdateMessagingPlatformRequestSchema)
    .output(type<MessagingSnapshot>()),
  decidePairing: mutation
    .input(MessagingPairingDecisionRequestSchema)
    .output(type<MessagingSnapshot>()),
  updateSettings: mutation
    .input(UpdateMessagingSettingsRequestSchema)
    .output(type<MessagingSnapshot>()),
  /** Which bot the user's own chat on a chat app goes to (its home bot). */
  setHomeBot: mutation
    .input(v.object({ platformId: MessagingPlatformIdSchema, botId: BotId }))
    .output(type<MessagingSnapshot>()),
  /** Reopen the platform's own web login window. */
  showLogin: mutation.input(PlatformInput).output(type<void>()),
  /**
   * Its connect dialog closed unlinked: hide the login and keep it running,
   * since a scan may still land; main turns it off if none does in time.
   */
  releaseLogin: mutation.input(PlatformInput).output(type<void>()),
  /** Try now: restart a lane that is down, without waiting for its next try. */
  retryNow: mutation.input(PlatformInput).output(type<MessagingSnapshot>()),
  /** The Messaging page opened: lanes that are down try again soon. */
  pageOpened: mutation.input(NoInput).output(type<void>()),
  /** The user's Unlink: off, and any login stored on this computer is gone. */
  unlinkPlatform: mutation
    .input(PlatformInput)
    .output(type<MessagingSnapshot>()),
  /** Mint a pairing code for a shared-bot platform. */
  pairShared: mutation.input(PlatformInput).output(type<MessagingSnapshot>()),
  unlinkShared: mutation.input(PlatformInput).output(type<MessagingSnapshot>()),
  /** In the app's own window, never the OS; the consent page in its Discord window. */
  openSharedLink: mutation
    .input(
      v.object({
        platformId: MessagingPlatformIdSchema,
        target: v.optional(v.picklist(SHARED_LINK_TARGETS)),
      })
    )
    .output(type<string | void>()),
  events: subscription
    .input(NoInput)
    .output(eventIterator(type<MessagingEvent>())),
};
