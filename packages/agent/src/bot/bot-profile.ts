/**
 * A bot's forever chat as a ForeverProfile: the persona-led operating prompt,
 * the memory/time/reaction tools and bash, and the daily-notes memory with its
 * pre-compaction flush and daily consolidation into MEMORY.md.
 */
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";

import { backendOperations, localBashOperations } from "../backends.js";
import { withBackgroundOption } from "../background-bash.js";
import type { ForeverProfile } from "../forever/profile.js";
import { buildOwnerTools } from "../owner-tools.js";
import { RecentUserText } from "../traveler/traveler-tool.js";
import { botDir, readBotState, writeBotState } from "./bot-config.js";
import { BOT_MEMORY_TOOL_NAME, buildBotMemoryTool } from "./bot-memory-tool.js";
import {
  coreMemoryPrompt,
  hasDailyNotes,
  memoryFingerprint,
  recentNotesPrompt,
} from "./bot-memory.js";
import {
  BOT_COMPACTION_CONTINUATION_PROMPT,
  BOT_COMPACTION_CONTINUATION_TYPE,
  BOT_LANGUAGE_REPAIR_TYPE,
  BOT_MALFORMED_CONTINUATION_PROMPT,
  BOT_MALFORMED_CONTINUATION_TYPE,
  botOperatingPrompt,
  CONSOLIDATE_CUSTOM_TYPE,
  consolidatePrompt,
  FLUSH_CUSTOM_TYPE,
  flushPrompt,
} from "./bot-prompts.js";
import {
  BOT_REACTION_TOOL_NAME,
  buildBotReactionTool,
} from "./bot-reaction-tool.js";
import { BOT_TIME_TOOL_NAME, buildBotTimeTool } from "./bot-time-tool.js";

/**
 * Flush when the estimated transcript passes this share of the window, ahead
 * of the 20% compaction reserve so notes are on disk before the summary.
 */
const FLUSH_AT_WINDOW_SHARE = 0.55;

/** How often the consolidation pass runs, at most. */
const CONSOLIDATE_EVERY_MS = 24 * 60 * 60_000;

/**
 * The bot's `bash`, over the same operations as the coding session's: the
 * bundled shell on Windows and the sandbox elsewhere. A custom tool of this
 * name replaces pi's built-in, whose own shell lookup finds nothing on a
 * Windows machine without Git Bash.
 */
export function botBashTool(
  cwd: string,
  operations = backendOperations() ?? localBashOperations()
): ReturnType<typeof createBashToolDefinition> {
  return withBackgroundOption(
    createBashToolDefinition(cwd, { operations }) as never,
    cwd,
    operations
  );
}

/** The bot whose directory ABACUSAI_BOT_BOT_DIR names. */
export function createBotProfile(): ForeverProfile {
  const home = botDir();

  if (home == null)
    throw new Error("BotSession requires ABACUSAI_BOT_BOT_DIR.");

  // What the user wrote lately: a saved traveler's consent must be their words.
  const recentUserText = new RecentUserText();

  return {
    systemPrompt: () => [botOperatingPrompt()],
    tools: (cwd) => [
      buildBotMemoryTool(home),
      buildBotTimeTool(),
      buildBotReactionTool(),
      ...buildOwnerTools({ recentUserText }),
      botBashTool(cwd),
    ],
    // The bot's own memory tool replaces the desktop's global one.
    replacesMcpTool: (name) =>
      name === BOT_MEMORY_TOOL_NAME ||
      name.endsWith(`_${BOT_MEMORY_TOOL_NAME}`) ||
      name === BOT_TIME_TOOL_NAME ||
      name === BOT_REACTION_TOOL_NAME,
    alwaysAllowedTools: [BOT_REACTION_TOOL_NAME],
    canAskForApproval: true,
    memory: {
      sessionStartPrompt: () => recentNotesPrompt(home),
      standingPrompt: () => coreMemoryPrompt(home),
      fingerprint: () => memoryFingerprint(home),
      flushAtWindowShare: FLUSH_AT_WINDOW_SHARE,
      flush: () => ({ customType: FLUSH_CUSTOM_TYPE, content: flushPrompt() }),
      claimConsolidation: () => {
        const state = readBotState(home);
        const due =
          hasDailyNotes(home) &&
          Date.now() - (state.lastConsolidatedAt ?? 0) > CONSOLIDATE_EVERY_MS;

        if (!due) return null;

        // Stamped before the turn so an erroring consolidation does not retry
        // on every message all day.
        writeBotState(home, { ...state, lastConsolidatedAt: Date.now() });
        return {
          customType: CONSOLIDATE_CUSTOM_TYPE,
          content: consolidatePrompt(),
        };
      },
    },
    continuations: {
      compaction: {
        customType: BOT_COMPACTION_CONTINUATION_TYPE,
        content: BOT_COMPACTION_CONTINUATION_PROMPT,
      },
      malformedToolCall: {
        customType: BOT_MALFORMED_CONTINUATION_TYPE,
        content: BOT_MALFORMED_CONTINUATION_PROMPT,
      },
      languageRepairType: BOT_LANGUAGE_REPAIR_TYPE,
    },
    // A details stop the user answered binds where saved travelers fill.
    browserTask: { userWords: recentUserText.read },
    beforeTurn: () => "",
    noteUserWords: (text) => recentUserText.note(text),
    afterTurn: () => undefined,
  };
}
