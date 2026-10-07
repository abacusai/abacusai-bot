/**
 * The seam between the forever-chat engine and what a particular chat is: the
 * engine owns the model, recovery and protocol; a profile owns its prompts,
 * tools and memory.
 */
import type { BrowserTaskContext } from "../browser-task.js";

/** A hidden or continuation message: its custom-message type and its text. */
export interface HiddenTurnPrompt {
  customType: string;
  content: string;
  /** Takes the turn's final reply; false counts the turn as failed. */
  accept?(reply: string): boolean | Promise<boolean>;
}

/** What the chat remembers, and the hidden turns that keep it. */
export interface ForeverMemoryPolicy {
  /** Read once at session start and frozen: the bridge from the last session. */
  sessionStartPrompt(): string | null;
  /** Re-read on every standing-prompt rebuild. */
  standingPrompt(): string | null;
  /** Changes when the standing prompt would; a change rebuilds it. */
  fingerprint(): string;
  /** Flush once per compaction cycle past this share of the context window. */
  flushAtWindowShare: number;
  /** Measure that share over the whole live transcript, not the last run. */
  measureFlushOnFullTranscript?: boolean;
  flush(): HiddenTurnPrompt;
  /** The consolidation turn when one is due, else null; claiming it stamps the run. */
  claimConsolidation(): HiddenTurnPrompt | null;
}

/** What the model is told when the engine carries a turn on. */
export interface ForeverContinuations {
  /** After the transcript was compacted to fit. */
  compaction: HiddenTurnPrompt;
  /** After a malformed tool call was dropped. */
  malformedToolCall: HiddenTurnPrompt;
  /** The custom type a reply-language repair is sent under. */
  languageRepairType: string;
}

export interface ForeverProfile {
  /** Standing prompt parts after pi's base prompt, fixed for the session. */
  systemPrompt(): string[];
  /** The profile's own pi tool definitions, ahead of browser_task and MCP. */
  tools(cwd: string): unknown[];
  /** Whether an MCP tool is replaced by one of the profile's own tools. */
  replacesMcpTool(name: string): boolean;
  /** Tools that never ask for approval. */
  alwaysAllowedTools: readonly string[];
  /** Whether anyone can answer an approval request; when not, a call that needs one is refused at once. */
  canAskForApproval: boolean;
  memory: ForeverMemoryPolicy;
  continuations: ForeverContinuations;
  /** Extra context sent with the user's message; "" for none. */
  beforeTurn(message: string): string | Promise<string>;
  /** Housekeeping once the turn and its memory maintenance are over. */
  afterTurn(): void | Promise<void>;
  /** Each user and assistant message of a visible turn, as it ends. */
  onMessage?(message: unknown): void;
  /** The messages a compaction is about to summarize away, before it does. */
  beforeCompaction?(messages: readonly unknown[]): void | Promise<void>;
  /** What a `browser_task` run gets beyond the browser: a way to reach the user. */
  browserTask?: Pick<BrowserTaskContext, "progressTools" | "channel">;
}
