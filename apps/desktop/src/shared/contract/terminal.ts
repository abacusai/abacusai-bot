import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import type {
  StartTerminalSessionResult,
  TerminalSessionSnapshot,
} from "../contracts";
import type { TerminalShellId, TerminalShellState } from "../terminal-shells";
import { mutation, query, subscription } from "./base";
import {
  ConversationKeySchema,
  ConversationRefSchema,
  DraftConversationRefSchema,
  NoInput,
  SessionConversationRefSchema,
  TerminalId,
} from "./ids";

export const TerminalShellIdSchema = v.picklist([
  "system",
  "cmd",
  "powershell",
  "pwsh",
  "busybox",
] as TerminalShellId[]);

const Dimension = v.pipe(v.number(), v.integer(), v.minValue(1));
const Generation = v.pipe(v.number(), v.integer(), v.minValue(0));

export const StartTerminalSessionRequestSchema = v.object({
  terminalId: v.optional(TerminalId),
  conversationKey: ConversationKeySchema,
  conversation: ConversationRefSchema,
  generation: v.nullable(Generation),
  cols: Dimension,
  rows: Dimension,
  shell: v.optional(TerminalShellIdSchema),
});

const runtimeEntries = {
  terminalId: v.optional(TerminalId),
  conversationKey: ConversationKeySchema,
  generation: Generation,
  close: v.optional(v.boolean()),
};

export const TerminalRuntimeRequestSchema = v.object(runtimeEntries);

export const WriteTerminalInputRequestSchema = v.object({
  ...runtimeEntries,
  data: v.string(),
});

export const ResizeTerminalSessionRequestSchema = v.object({
  ...runtimeEntries,
  cols: Dimension,
  rows: Dimension,
});

export const PromoteTerminalSessionScopeRequestSchema = v.object({
  draftConversationKey: ConversationKeySchema,
  draftConversation: DraftConversationRefSchema,
  sessionConversationKey: ConversationKeySchema,
  sessionConversation: SessionConversationRefSchema,
});

/**
 * Offset-addressed output. `offset` is the cumulative UTF-8 byte count of the
 * terminal's output after this chunk, so a reopen with `fromOffset` resumes
 * with no gap and no duplicate.
 */
export type TerminalOutputChunk =
  /**
   * First: the bytes after `fromOffset` when main still holds them
   * (`from === fromOffset`: append), else the whole scrollback (`from` is
   * where it starts: replace what you have).
   */
  | { type: "snapshot"; data: string; from: number; offset: number }
  | { type: "data"; data: string; offset: number }
  /** Exactly once, then the iterator returns. Sticky for a late subscriber. */
  | { type: "exit"; exitCode: number | null; signal: number | null };

export type TerminalEvent =
  /** First yield on (re)open: every terminal's state in scope. */
  | { type: "snapshot"; states: TerminalSessionSnapshot[] }
  | { type: "state"; state: TerminalSessionSnapshot };

export const terminal = {
  start: mutation
    .input(StartTerminalSessionRequestSchema)
    .output(type<StartTerminalSessionResult>()),
  /** Fire-and-forget: callers do not await it; the port keeps order. */
  write: mutation
    .input(WriteTerminalInputRequestSchema)
    .output(type<boolean>()),
  resize: mutation
    .input(ResizeTerminalSessionRequestSchema)
    .output(type<boolean>()),
  hide: mutation.input(TerminalRuntimeRequestSchema).output(type<boolean>()),
  promoteScope: mutation
    .input(PromoteTerminalSessionScopeRequestSchema)
    .output(type<TerminalSessionSnapshot | null>()),
  shell: {
    get: query.input(NoInput).output(type<TerminalShellState>()),
    /** Also stored, so the next automatic terminal opens the same shell. */
    set: mutation
      .input(v.object({ shell: TerminalShellIdSchema }))
      .output(type<TerminalShellState>()),
  },
  /**
   * One terminal's output, lossless and replayable. Overflow ends the stream
   * with `RESYNC_REQUIRED`; reopen with the last `offset` seen.
   */
  output: subscription
    .input(
      v.object({
        conversationKey: ConversationKeySchema,
        terminalId: v.optional(TerminalId),
        generation: Generation,
        fromOffset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
      })
    )
    .output(eventIterator(type<TerminalOutputChunk>())),
  events: subscription
    .input(
      v.optional(
        v.object({ conversationKey: v.optional(ConversationKeySchema) })
      )
    )
    .output(eventIterator(type<TerminalEvent>())),
};
