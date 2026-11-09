/**
 * A bot's forever chat as a ForeverProfile: the persona-led operating prompt,
 * the memory/time/reaction tools and bash. A bot is a project in the memory
 * folder (memory/lanes.ts says what its owner's and its senders' chats may
 * keep); a pre-compaction flush writes what the summary would lose.
 */
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";

import { agentShellOperations } from "../backends.js";
import { withBackgroundOption } from "../background-bash.js";
import type { ForeverProfile } from "../forever/profile.js";
import { ChatMemory, MEMORY_SAVE_CHECK_TYPE } from "../memory/chat.js";
import { MEMORY_TOOL_NAME } from "../memory/tool.js";
import { buildOwnerTools, isOwnerAudience } from "../owner-tools.js";
import { RecentUserText } from "../traveler/traveler-tool.js";
import { buildSetUserLanguageTool } from "../user-language.js";
import { botDir } from "./bot-config.js";
import {
  BOT_COMPACTION_CONTINUATION_PROMPT,
  BOT_COMPACTION_CONTINUATION_TYPE,
  BOT_EMPTY_REPLY_PROMPT,
  BOT_EMPTY_REPLY_TYPE,
  BOT_LANGUAGE_REPAIR_TYPE,
  BOT_MALFORMED_CONTINUATION_PROMPT,
  BOT_MALFORMED_CONTINUATION_TYPE,
  botOperatingPrompt,
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

/**
 * The bot's `bash`, over the same operations as the coding session's: the
 * bundled shell on Windows and the sandbox elsewhere. A custom tool of this
 * name replaces pi's built-in, whose own shell lookup finds nothing on a
 * Windows machine without Git Bash.
 */
export function botBashTool(
  cwd: string,
  operations = agentShellOperations()
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
  let memory: ChatMemory | null = null;
  const chatMemory = (): ChatMemory => {
    if (memory == null) throw new Error("bot memory used before prepare()");
    return memory;
  };

  return {
    prepare: async (mode) => {
      memory = new ChatMemory(
        home,
        mode,
        () =>
          recentUserText
            .read()
            .map((each) => each.text)
            .join("\n\n"),
        () => undefined
      );
      await memory.start();
    },
    systemPrompt: () => [botOperatingPrompt()],
    tools: (cwd) => [
      ...(chatMemory().tool() != null ? [chatMemory().tool()] : []),
      buildBotTimeTool(),
      buildBotReactionTool(),
      ...buildOwnerTools({ recentUserText }),
      // Only the user's own chat saves their language: a sender is someone else.
      ...(isOwnerAudience() ? [buildSetUserLanguageTool()] : []),
      botBashTool(cwd),
    ],
    // The chat's own memory tool; no MCP server serves one.
    replacesMcpTool: (name) =>
      name === MEMORY_TOOL_NAME ||
      name.endsWith(`_${MEMORY_TOOL_NAME}`) ||
      name === BOT_TIME_TOOL_NAME ||
      name === BOT_REACTION_TOOL_NAME,
    alwaysAllowedTools: [BOT_REACTION_TOOL_NAME],
    canAskForApproval: true,
    memory: {
      // The block is built once, in prepare(): it sits in the cached prefix.
      recentPrompt: () => null,
      standingPrompt: () => chatMemory().prompt(),
      fingerprint: () => "",
      flushAtWindowShare: FLUSH_AT_WINDOW_SHARE,
      flush: () => ({ customType: FLUSH_CUSTOM_TYPE, content: flushPrompt() }),
      saveCheck: (ownWords) => {
        const content = chatMemory().saveCheck(ownWords);
        return content == null
          ? null
          : {
              customType: MEMORY_SAVE_CHECK_TYPE,
              content: `${content} Then reply with exactly NO_REPLY.`,
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
      emptyReply: {
        customType: BOT_EMPTY_REPLY_TYPE,
        content: BOT_EMPTY_REPLY_PROMPT,
      },
    },
    // A details stop the user answered binds where saved travelers fill.
    browserTask: { userWords: recentUserText.read },
    // What changed in memory elsewhere since the last turn, as a hidden line.
    beforeTurn: (message) => chatMemory().beginTurn(message),
    noteUserWords: (text) => recentUserText.note(text),
    afterTurn: () => undefined,
  };
}
