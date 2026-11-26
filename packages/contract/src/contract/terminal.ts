import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import type {
  StartTerminalSessionResult,
  TerminalSessionSnapshot,
} from "../contracts";
import {
  TERMINAL_SHELLS,
  type TerminalShellId,
  type TerminalShellState,
} from "../terminal-shells";
import { mutation, query, subscription } from "./base";
import {
  ConversationKeySchema,
  ConversationRefSchema,
  DraftConversationRefSchema,
  NoInput,
  SessionConversationRefSchema,
  TerminalId,
} from "./ids";

// Every shell the menus can offer, from the shell table.
export const TerminalShellIdSchema = v.picklist(
  TERMINAL_SHELLS.map((shell) => shell.id) as TerminalShellId[]
);

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
  /**
   * Exactly one of `exit` or `retired`, then the iterator returns. Both are
   * sticky for a late subscriber.
   */
  | { type: "exit"; exitCode: number | null; signal: number | null }
  /**
   * This generation ended without an exit of its own: `closed` (the terminal
   * was closed, or its scope or workspace disposed), or `superseded` (a
   * scope promotion moved the shell to a new key and generation; the
   * terminal state events name the new one), or `quit` (the app is
   * quitting; the tab is kept and reopens with a fresh shell).
   */
  | { type: "retired"; reason: "closed" | "superseded" | "quit" };

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
  /** The output offset at which the PTY took the size, or false. */
  resize: mutation
    .input(ResizeTerminalSessionRequestSchema)
    .output(type<number | false>()),
  hide: mutation.input(TerminalRuntimeRequestSchema).output(type<boolean>()),
  /**
   * Ends a tab's shell, or every shell of the conversation when no tab is
   * named, whatever generation it reached (one still starting included).
   * Main owns the shells: closing needs no screen in the window.
   */
  close: mutation
    .input(
      v.object({
        conversationKey: ConversationKeySchema,
        terminalId: v.optional(TerminalId),
      })
    )
    .output(type<boolean>()),
  /**
   * The programs running in place of a prompt in a chat's terminals, or in a
   * whole workspace's: what deleting it would stop. Empty where the platform
   * can't tell (Windows).
   */
  busyIn: query
    .input(
      v.object({ workspaceId: v.string(), sessionId: v.optional(v.string()) })
    )
    .output(type<{ program: string; chat: string }[]>()),
  /**
   * The program running in place of the shell's prompt (a dev server, an
   * editor), or null at the prompt or where the platform can't tell. Closing
   * such a terminal asks first.
   */
  busy: query
    .input(TerminalRuntimeRequestSchema)
    .output(type<{ program: string | null }>()),
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
