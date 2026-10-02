/**
 * Valibot atoms for ids, paths and URLs (spec 00 A.1). Ids reuse the
 * transcript path guard (`isSafeSessionId` in
 * main/services/session/thread-store.ts): a path separator or leading dot in
 * an id would let a caller address a file outside the store it names.
 */
import * as v from "valibot";

import type { AgentMode } from "../agent-types";
import {
  conversationRefFromKey,
  type ConversationKey,
} from "../conversation-scope";

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

const id = (label: string) =>
  v.pipe(
    v.string(),
    v.nonEmpty(`${label} is required`),
    v.regex(SAFE_ID, `${label} has characters an id cannot have`),
    v.check((value) => !value.startsWith("."), `${label} cannot start with "."`)
  );

export const SessionId = id("sessionId");
export const WorkspaceId = id("workspaceId");
export const BotId = id("botId");
export const RoutineId = id("routineId");
export const TerminalId = id("terminalId");

const isAbsolutePath = (value: string): boolean =>
  // posix, a Windows drive, or a UNC share.
  value.startsWith("/") ||
  /^[A-Za-z]:[\\/]/.test(value) ||
  value.startsWith("\\\\");

export const AbsPath = v.pipe(
  v.string(),
  v.check(isAbsolutePath, "an absolute path is required")
);

export const HttpUrl = v.pipe(
  v.string(),
  v.url(),
  v.check((value) => /^https?:/i.test(value), "an http(s) URL is required")
);

/** A key minted by `conversationKey()`; anything else is refused. */
export const ConversationKeySchema = v.custom<ConversationKey>(
  (value) =>
    typeof value === "string" &&
    conversationRefFromKey(value as ConversationKey) != null,
  "not a conversation key"
);

export const DraftConversationRefSchema = v.object({
  version: v.literal(1),
  kind: v.literal("draft"),
  workspaceId: v.string(),
});

export const SessionConversationRefSchema = v.object({
  version: v.literal(1),
  kind: v.literal("session"),
  workspaceId: v.string(),
  sessionId: v.string(),
});

export const ConversationRefSchema = v.variant("kind", [
  DraftConversationRefSchema,
  SessionConversationRefSchema,
]);

// The enum's values spelled out, typed as the enum: the schema's output is
// `AgentMode` without a runtime import of the agent wire types.
export const AgentModeSchema = v.picklist([
  "DEFAULT",
  "ACCEPTEDITS",
  "PLAN",
  "AUTO",
  "YOLO",
] as AgentMode[]);

/** Procedures that take nothing still take an (optional) object. */
export const NoInput = v.optional(v.object({}));
