/**
 * The phone loop as a ForeverProfile: one lifelong WhatsApp conversation with
 * layered memory under ABACUSAI_BOT_PHONE_DIR, a capped standing prompt,
 * lexical recall with every message, a JSON flush before compaction and a
 * daily consolidation.
 */
import {
  BOT_REACTION_TOOL_NAME,
  buildBotReactionTool,
} from "../bot/bot-reaction-tool.js";
import { BOT_TIME_TOOL_NAME, buildBotTimeTool } from "../bot/bot-time-tool.js";
import { WHATSAPP_CHANNEL } from "../channel.js";
import type { ForeverProfile } from "../forever/profile.js";
import { buildOwnerTools, OWNER_TOOL_NAMES } from "../owner-tools.js";
import { buildSendMediaTool } from "../send-media-tool.js";
import { SEND_MEDIA_TOOL_NAME } from "../send-media.js";
import { PHONE_MCP_TOOLS } from "../tool-policy.js";
import { RecentUserText } from "../traveler/traveler-tool.js";
import { PHONE_PROGRESS_TOOL_NAME } from "./phone-bubbles.js";
import {
  localDay,
  phoneDir,
  readPhoneState,
  writePhoneState,
} from "./phone-config.js";
import {
  buildPhoneMemoryTool,
  PHONE_MEMORY_TOOL_NAME,
} from "./phone-memory-tool.js";
import {
  flagStaleLoops,
  latestArchiveAt,
  phoneMemoryFingerprint,
  phoneStandingPrompt,
} from "./phone-memory.js";
import {
  buildPhonePageTool,
  type PagePublisher,
  PHONE_PAGE_TOOL_NAME,
} from "./phone-page-tool.js";
import { buildPhoneProgressTool } from "./phone-progress-tool.js";
import {
  PHONE_COMPACTION_CONTINUATION_PROMPT,
  PHONE_COMPACTION_CONTINUATION_TYPE,
  PHONE_CONSOLIDATE_TYPE,
  PHONE_FLUSH_TYPE,
  PHONE_LANGUAGE_REPAIR_TYPE,
  PHONE_MALFORMED_CONTINUATION_PROMPT,
  PHONE_MALFORMED_CONTINUATION_TYPE,
  phoneConsolidatePrompt,
  phoneFlushPrompt,
  phoneOperatingPrompt,
} from "./phone-prompts.js";
import { recallBlock } from "./phone-recall.js";
import {
  applyConsolidation,
  applyFlush,
  archiveLive,
  beforePhoneCompaction,
  consolidationInput,
} from "./phone-upkeep.js";

/** Same trigger as the bot: flush past this share of the context window. */
const FLUSH_AT_WINDOW_SHARE = 0.55;

const CONSOLIDATE_EVERY_MS = 24 * 60 * 60_000;

/** Flush turns tried per compaction window before giving up on it. */
const MAX_FLUSH_ATTEMPTS = 2;

/** The phone loop's own tools, all always allowed: nobody can approve over WhatsApp. */
const PHONE_TOOL_NAMES = [
  PHONE_MEMORY_TOOL_NAME,
  PHONE_PAGE_TOOL_NAME,
  BOT_TIME_TOOL_NAME,
  BOT_REACTION_TOOL_NAME,
  PHONE_PROGRESS_TOOL_NAME,
  SEND_MEDIA_TOOL_NAME,
  ...OWNER_TOOL_NAMES,
];

export interface PhoneProfileOptions {
  /** The model reference the chat runs on, for "which model are you?". */
  model: string | null;
  /** Publishes `page` content; without one the tool says it is unavailable. */
  pagePublisher?: PagePublisher;
}

/** The phone loop whose directory ABACUSAI_BOT_PHONE_DIR names. */
export function createPhoneProfile(
  options: PhoneProfileOptions
): ForeverProfile {
  const home = phoneDir();

  if (home == null)
    throw new Error("PhoneSession requires ABACUSAI_BOT_PHONE_DIR.");

  // A new conversation starts the consolidation clock: the first run is a day
  // out, never on the first message.
  const state = readPhoneState(home);

  if (state.lastConsolidatedAt == null)
    writePhoneState(home, { ...state, lastConsolidatedAt: Date.now() });

  let flushAttempts = 0;
  // What the user wrote lately: a saved traveler's consent must be their words.
  const recentUserText = new RecentUserText();

  return {
    systemPrompt: () => [phoneOperatingPrompt(options.model)],
    tools: () => [
      buildPhoneMemoryTool(home),
      buildPhonePageTool(home, options.pagePublisher),
      buildBotTimeTool(),
      buildBotReactionTool(),
      buildPhoneProgressTool(),
      buildSendMediaTool(),
      ...buildOwnerTools({ recentUserText }),
    ],
    // A browser run keeps the user posted, and hears them, from inside.
    browserTask: {
      userWords: recentUserText.read,
      progressTools: (sent) => [
        buildPhoneProgressTool(),
        buildSendMediaTool(sent),
      ],
      channel: WHATSAPP_CHANNEL,
    },
    mcpTools: PHONE_MCP_TOOLS,
    // The phone's own `memory` replaces the desktop's global one too.
    replacesMcpTool: (name) =>
      PHONE_TOOL_NAMES.includes(name) ||
      name.endsWith(`_${PHONE_MEMORY_TOOL_NAME}`),
    alwaysAllowedTools: PHONE_TOOL_NAMES,
    // Nobody can tap Approve in WhatsApp: waiting would freeze the chat.
    canAskForApproval: false,
    memory: {
      // The standing prompt already carries the last days; nothing to bridge.
      sessionStartPrompt: () => null,
      standingPrompt: () => phoneStandingPrompt(home, new Date()),
      fingerprint: () => phoneMemoryFingerprint(home, new Date()),
      flushAtWindowShare: FLUSH_AT_WINDOW_SHARE,
      measureFlushOnFullTranscript: true,
      flush: () => {
        const now = new Date();

        return {
          customType: PHONE_FLUSH_TYPE,
          content: phoneFlushPrompt(localDay(now)),
          accept: async (reply) => {
            flushAttempts += 1;
            const ok = await applyFlush(home, reply, now);

            // One retry per compaction window, not a hidden turn every turn.
            return ok || flushAttempts >= MAX_FLUSH_ATTEMPTS;
          },
        };
      },
      claimConsolidation: () => {
        const now = new Date();
        const state = readPhoneState(home);
        const last = state.lastConsolidatedAt ?? now.getTime();
        // Due a day after the last run, and only if anything was said since.
        const due =
          now.getTime() - last > CONSOLIDATE_EVERY_MS &&
          (latestArchiveAt(home) ?? 0) > last;

        if (!due) return null;

        // Stamped first so a failing consolidation does not retry all day.
        writePhoneState(home, { ...state, lastConsolidatedAt: now.getTime() });
        flagStaleLoops(home, now);

        const input = consolidationInput(home, now);

        return {
          customType: PHONE_CONSOLIDATE_TYPE,
          content: phoneConsolidatePrompt(input),
          accept: (reply) => applyConsolidation(home, reply, input, now),
        };
      },
    },
    continuations: {
      compaction: {
        customType: PHONE_COMPACTION_CONTINUATION_TYPE,
        content: PHONE_COMPACTION_CONTINUATION_PROMPT,
      },
      malformedToolCall: {
        customType: PHONE_MALFORMED_CONTINUATION_TYPE,
        content: PHONE_MALFORMED_CONTINUATION_PROMPT,
      },
      languageRepairType: PHONE_LANGUAGE_REPAIR_TYPE,
    },
    beforeTurn: (message) => recallBlock(home, message, new Date()),
    noteUserWords: (text) => recentUserText.note(text),
    afterTurn: () => undefined,
    onMessage: (message) => archiveLive(home, message),
    beforeCompaction: (messages) => {
      flushAttempts = 0;
      beforePhoneCompaction(home, messages);
    },
  };
}
