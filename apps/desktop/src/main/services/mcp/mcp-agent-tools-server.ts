import fs from "fs";
import http from "http";
import net from "net";
import path from "path";
import { pathToFileURL } from "url";

import { sendToRenderer } from "#main/renderer-host";
/**
 * The agent-tools MCP server: skills, task planning, memory, the web, and
 * more. One server rather than one per toolset, since all are small and
 * in-process; each toolset toggles on its own, so `tools/list` filters by the
 * enabled set and a disabled toolset's tools are never advertised.
 */
import { IpcChannels } from "#shared/channels";
import type { ConversationKey } from "#shared/conversation-scope";
import {
  AGENT_LINKABLE_CHAT_APPS,
  isMessagingPlatformId,
  type MessagingPlatformId,
  describePlatformForAgent,
} from "#shared/messaging";

import { WORKSPACE_DIR_NAME } from "../../paths";
import {
  createJob,
  describeJob,
  listJobs,
  removeJob,
  updateJob,
} from "../agent-tools/cron-store";
import { exportDeckPdf } from "../agent-tools/deck-pdf";
import {
  haCallService,
  haGetState,
  haListEntities,
  haListServices,
  homeAssistantReady,
  homeAssistantSetupHint,
  xSearch,
  xSearchReady,
  xSearchSetupHint,
} from "../agent-tools/integrations";
import {
  generateImage,
  generateSpeech,
  pollVideo,
  submitVideo,
  videoPromptingGuide,
} from "../agent-tools/media-generation";
import {
  applyMemoryAction,
  readEntries,
  type MemoryAction,
  type MemoryTarget,
} from "../agent-tools/memory-store";
import { analyze } from "../agent-tools/model-analysis";
import { reprintPdf, runPdfScript } from "../agent-tools/pdf-agent";
import {
  listServed,
  serveDirectory,
  stopDirectory,
  htmlPagesIn,
} from "../agent-tools/static-server";
import { renderTodos, readTodos, setTodos } from "../agent-tools/todo-store";
import { MAX_ATTACHMENT_BYTES } from "../messaging/connector";
import {
  resolveSender,
  type SenderCandidate,
} from "../messaging/sender-resolution";
import { artifactPathLine } from "../session/session-artifacts.utils";
import type { SkillsService } from "../workspace/skills-service";
import { localMcpServerToken } from "./mcp-config-service";
import { readTranscriptTail } from "./transcript-tail";

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const SERVER_NAME = "agent-tools";
const SERVER_VERSION = "1.0.0";

/**
 * Which toolset(s) each tool belongs to. A tool under several toolsets is
 * available when any is on, which keeps `bfl_flux3_get_result` reachable
 * beside every submitter that polls it. `ALWAYS_ENABLED` tools are absent.
 */
const TOOL_TOOLSET: Record<string, string | string[]> = {
  skills_list: "skills",
  skill_view: "skills",
  skill_manage: "skills",
  todo: "todo",
  memory: "memory",
  cronjob: "cronjob",
  vision_analyze: "vision",
  video_analyze: "video",
  image_generate: "image_gen",
  text_to_speech: "tts",
  video_generate: "video_gen",
  xai_video_edit: "video_gen",
  xai_video_extend: "video_gen",
  bfl_flux3_text_to_video: "bfl",
  bfl_flux3_image_to_video: "bfl",
  bfl_flux3_keyframes_to_video: "bfl",
  bfl_flux3_video_continuation: "bfl",
  bfl_flux3_get_result: ["bfl", "video_gen"],
  bfl_flux3_prompting_guide: ["bfl", "video_gen"],
  x_search: "x_search",
  ha_list_entities: "homeassistant",
  ha_get_state: "homeassistant",
  ha_list_services: "homeassistant",
  ha_call_service: "homeassistant",
  deck_export_pdf: "ppt",
  pdf: "pdf",
  send_chat_message: "messaging",
  list_chats: "messaging",
  list_whatsapp_chats: "messaging",
  list_telegram_chats: "messaging",
  list_discord_chats: "messaging",
  send_whatsapp_message: "messaging",
  read_whatsapp_messages: "messaging",
  whatsapp_auto_reply: "messaging",
  send_telegram_message: "messaging",
  read_telegram_messages: "messaging",
  telegram_auto_reply: "messaging",
  send_discord_message: "messaging",
  read_discord_messages: "messaging",
  discord_auto_reply: "messaging",
  read_chat_messages: "messaging",
  auto_reply: "messaging",
  connect_connector: "connectors",
  disconnect_connector: "connectors",
};

/**
 * On regardless of the toggles: they are how the agent shows what `write` or
 * `bash` produced, and gating them left deliverables the user found by path.
 * `serve` because `bash` runs to completion and kills a dev server as it
 * becomes ready. my_activity answers only a bot's own chat.
 */
const ALWAYS_ENABLED = new Set(["present_deliverable", "serve", "my_activity"]);

const toolsetsFor = (name: string): string[] => {
  const mapped = TOOL_TOOLSET[name];

  if (mapped == null) return [];

  return Array.isArray(mapped) ? mapped : [mapped];
};

const isKnownTool = (name: string): boolean =>
  ALWAYS_ENABLED.has(name) || toolsetsFor(name).length > 0;

const isToolEnabled = (name: string, enabled: Set<string>): boolean =>
  ALWAYS_ENABLED.has(name) ||
  toolsetsFor(name).some((toolset) => enabled.has(toolset));

/**
 * Tools only a bot may call. Enforced by leaving them out of the caller's
 * tool list rather than only refusing the call, so a session's model never
 * sees a tool it cannot use.
 */
const BOTS_ONLY = new Set([
  "auto_reply",
  "whatsapp_auto_reply",
  "telegram_auto_reply",
  "discord_auto_reply",
]);

/**
 * Never shown to the model: the cross-platform originals the per-platform
 * tools delegate to. They stay callable, but a platform's contacts and
 * messages must never appear beside another platform's in one result.
 */
const HIDDEN_FROM_MODEL = new Set([
  "send_chat_message",
  "read_chat_messages",
  "list_chats",
  "auto_reply",
]);

/** Chats an "everything unread" read opens before pointing at the list. */
const UNREAD_CHATS_READ_CAP = 10;
/** Messages per chat in an unread read when the caller gives no limit. */
const UNREAD_PER_CHAT_DEFAULT = 50;
/** For a chat marked unread by hand, which has no count to go by. */
const UNREAD_MARKED_PEEK = 5;

type UnreadFetch =
  | {
      ok: true;
      rows: Array<{ chatId: string; name: string; unreadCount: number }>;
    }
  | { ok: false; result: ToolResult };

/** WhatsApp's counter in words: negative is "marked unread", not a number. */
const describeUnread = (count: number): string =>
  count < 0 ? "marked unread" : `${count} unread`;

/** Per-platform tools are listed only while their platform runs. */
const TOOL_PLATFORM: Record<string, MessagingPlatformId> = {
  list_whatsapp_chats: "whatsapp",
  list_telegram_chats: "telegram",
  list_discord_chats: "discord",
  send_whatsapp_message: "whatsapp",
  send_telegram_message: "telegram",
  send_discord_message: "discord",
  read_whatsapp_messages: "whatsapp",
  read_telegram_messages: "telegram",
  read_discord_messages: "discord",
  whatsapp_auto_reply: "whatsapp",
  telegram_auto_reply: "telegram",
  discord_auto_reply: "discord",
};

/**
 * Tools a bot gets whatever the toggles say. `cronjob` defaults off for
 * sessions because unattended runs are reach nobody signed up for; a bot's
 * routines are asked for in its chat and listed under Routines.
 */
const BOT_ALWAYS = new Set(["cronjob", "my_activity"]);

/**
 * Whether a tool that needs a third-party credential has one. Consulted only
 * when listing, so a toolset can be on by default and cost no prompt budget
 * until it works. `tools/call` does not check: a model holding an older list
 * should get the setup hint, not "unknown tool".
 */
const READINESS: Record<string, () => boolean> = {
  x_search: xSearchReady,
  ha_list_entities: homeAssistantReady,
  ha_get_state: homeAssistantReady,
  ha_list_services: homeAssistantReady,
  ha_call_service: homeAssistantReady,
};

/**
 * A `file://` URL the chat's markdown renderer will linkify. pathToFileURL,
 * not interpolation: it escapes what the renderer decodes back and handles
 * Windows paths, where a raw `C:` parses as the URL's authority.
 */
const fileUrl = (absolutePath: string): string =>
  pathToFileURL(absolutePath).href;

const TOOLS_SCHEMA: Record<
  string,
  { description: string; inputSchema: Record<string, unknown> }
> = {
  skills_list: {
    description:
      "List the skills available in this workspace and globally, with their descriptions.",
    inputSchema: { type: "object", properties: {} },
  },
  skill_view: {
    description:
      "Read a skill's full instructions. Use skills_list first to find its id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The skill id from skills_list." },
      },
      required: ["id"],
    },
  },
  skill_manage: {
    description:
      "Open a skill file for editing. Returns the path so it can be read or written with the file tools.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The skill id from skills_list." },
      },
      required: ["id"],
    },
  },
  todo: {
    description: [
      "Track a plan for multi-step work.",
      "",
      "Actions:",
      '  "set"  — replace the whole plan (required: todos).',
      '  "list" — read the current plan.',
      "",
      "Write the full list every time rather than editing single items. Exactly one item may be in_progress.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set", "list"] },
        todos: {
          type: "array",
          description: 'The complete plan, required for "set".',
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["action"],
    },
  },
  memory: {
    description: [
      "Remember something across sessions.",
      "",
      "Targets:",
      '  "memory" — your own notes: environment facts, project conventions, tool quirks.',
      '  "user"   — what you know about the person: preferences, habits, how they work.',
      "",
      "Actions:",
      '  "add"     — store a new entry (required: content).',
      '  "replace" — swap an entry out (required: match, content).',
      '  "remove"  — forget an entry (required: match).',
      "",
      '"match" is a short fragment that identifies exactly one entry — not the whole text.',
      "Writes land on disk immediately but only reach your system prompt next session.",
      "Keep this curated: store what stays true, not what merely happened.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["memory", "user"] },
        action: { type: "string", enum: ["add", "replace", "remove"] },
        content: {
          type: "string",
          description: "The entry text, for add and replace.",
        },
        match: {
          type: "string",
          description: "A short unique fragment, for replace and remove.",
        },
      },
      required: ["target", "action"],
    },
  },
  cronjob: {
    description: [
      "Schedule the agent to run a prompt on its own — on a clock, on an incoming webhook, or both.",
      "",
      'Actions: "create" (prompt, and schedule and/or webhook: true; optional name), "list",',
      '"update" (id, and any of name/schedule/prompt/enabled), "pause" (id), "resume" (id),',
      '"remove" (id), "run" (id, to fire it now).',
      "",
      "When an update changes what a routine does, change its name to match in the same call.",
      'The name is what the user sees in the Routines panel and what you read back in "list";',
      "one that describes the old job is a routine both of you will misread later.",
      "",
      'Schedules are five-field cron in local time: "minute hour day month weekday".',
      '  "0 9 * * *"    every day at 09:00',
      '  "*/15 * * * *" every fifteen minutes',
      '  "0 9 * * 1"    Mondays at 09:00',
      "Names like MON are not supported, and neither is a seconds field.",
      "Reach for sensible defaults: pin loose asks to weekdays and waking hours unless the",
      "routine is about the user's life rather than their work, and inherit the current minute",
      'when the user names only an hour — asked at 1:32, "daily at 2" means "32 2 * * *".',
      "",
      "A routine with a schedule also fires once the moment it is created, whatever its",
      "schedule says, so the user sees it work instead of waiting out the first gap. Tell them",
      "so, and write the prompt so an off-schedule first run still makes sense.",
      "",
      "webhook: true makes the routine firable by an outside POST; the user copies its URL",
      "from the Routines panel. The request body arrives as data in the fire prompt.",
      "",
      "In a bot's own chat, routines you create belong to the bot and their fires are",
      "delivered back into this conversation. Everywhere else a fire starts a fresh session",
      "with no memory of this conversation, so write the prompt to stand alone.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "create",
            "list",
            "update",
            "pause",
            "resume",
            "remove",
            "run",
          ],
        },
        id: { type: "string" },
        name: {
          type: "string",
          description:
            "Short display name for the Routines panel, on create or update.",
        },
        schedule: {
          type: "string",
          description: "Five-field cron expression.",
        },
        webhook: {
          type: "boolean",
          description:
            "create: also mint a webhook URL that fires this routine.",
        },
        prompt: {
          type: "string",
          description: "What to ask the agent when it fires.",
        },
        enabled: {
          type: "boolean",
          description: "update: enable or pause the job.",
        },
      },
      required: ["action"],
    },
  },
  vision_analyze: {
    description:
      "Look at an image and answer a question about it. Accepts a local file path or an http(s) URL.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Image path or URL." },
        prompt: {
          type: "string",
          description:
            "What you want to know. Defaults to a general description.",
        },
      },
      required: ["source"],
    },
  },
  video_analyze: {
    description:
      "Watch a video and answer a question about it. Needs a video-capable model — not every vision provider accepts video.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Video path or URL." },
        prompt: { type: "string", description: "What you want to know." },
      },
      required: ["source"],
    },
  },
  image_generate: {
    description:
      "Generate an image from a prompt. Returns the path to the saved file, which you should show to the user as a markdown image so it renders in the chat. Never link to an image on a third-party site instead of generating one.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        size: {
          type: "string",
          description: 'Provider-specific, e.g. "1024x1024".',
        },
      },
      required: ["prompt"],
    },
  },
  text_to_speech: {
    description:
      "Turn text into spoken audio. Returns the path to the saved file.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        voice: {
          type: "string",
          description: "Provider-specific voice name or id.",
        },
      },
      required: ["text"],
    },
  },
  video_generate: {
    description:
      "Start generating a video from a prompt, optionally driven by a still image. Returns a job id — generation takes minutes, so poll with bfl_flux3_get_result.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        image_url: {
          type: "string",
          description: "Optional still to animate.",
        },
      },
      required: ["prompt"],
    },
  },
  xai_video_edit: {
    description:
      "Re-generate an existing video against a new prompt. Returns a job id to poll.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string" }, video_url: { type: "string" } },
      required: ["prompt", "video_url"],
    },
  },
  xai_video_extend: {
    description:
      "Continue an existing video past its end. Returns a job id to poll.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string" }, video_url: { type: "string" } },
      required: ["prompt", "video_url"],
    },
  },
  bfl_flux3_text_to_video: {
    description:
      "Start a video generation from a prompt alone. Returns a job id to poll.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
    },
  },
  bfl_flux3_image_to_video: {
    description:
      "Start a video generation from a still image. Returns a job id to poll.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string" }, image_url: { type: "string" } },
      required: ["prompt", "image_url"],
    },
  },
  bfl_flux3_keyframes_to_video: {
    description:
      "Start a video generation that passes through given keyframes. Returns a job id to poll.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        keyframes: {
          type: "array",
          items: { type: "string" },
          description: "Image URLs, in order.",
        },
      },
      required: ["prompt", "keyframes"],
    },
  },
  bfl_flux3_video_continuation: {
    description: "Continue an existing video. Returns a job id to poll.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string" }, video_url: { type: "string" } },
      required: ["prompt", "video_url"],
    },
  },
  bfl_flux3_get_result: {
    description:
      "Check a video job. Returns the file path once it is done, or how long it has been running. Poll every 20-30 seconds rather than in a tight loop.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  bfl_flux3_prompting_guide: {
    description:
      "Read guidance on writing video prompts before generating. Costs nothing and improves results.",
    inputSchema: { type: "object", properties: {} },
  },
  x_search: {
    description:
      "Search public posts and threads on X. Returns a summary with links.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  ha_list_entities: {
    description:
      "List Home Assistant entities and their current state. Filter to avoid a wall of output.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Substring to match on id or friendly name.",
        },
      },
    },
  },
  ha_get_state: {
    description: "Read one entity's state and full attributes.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "e.g. light.kitchen" },
      },
      required: ["entity_id"],
    },
  },
  ha_list_services: {
    description: "List services that can be called, optionally for one domain.",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string", description: "e.g. light" } },
    },
  },
  pdf: {
    description: [
      "Work with a PDF that already exists: read it, or change it.",
      "",
      "To WRITE a new document, use `document` instead — it plans and writes one and prints",
      "it. This tool does not author content.",
      "",
      "Actions:",
      '  "reprint"— print a document again from its HTML source (html_path).',
      "             Every document leaves an editable `document.html` beside its PDF. Edit",
      "             that file to change what the document says, then reprint it: the PDF is",
      "             updated in place. This is how you edit a document — the other actions",
      "             move pages around and cannot change a word of the text.",
      '  "read"   — text per page (path, optional pages).',
      '  "tables" — tables as rows, per page (path, optional pages).',
      '  "info"   — page count, metadata, and whether the text is extractable at all.',
      "             Run this first on a PDF you did not make: a scanned one yields no",
      "             text and needs OCR.",
      '  "merge"  — concatenate several PDFs (inputs, output_path).',
      '  "split"  — write one PDF per page range (path, output_dir, optional ranges).',
      '  "rotate" — rotate pages (path, output_path, degrees, optional pages).',
      '  "stamp"  — draw a watermark across every page (path, output_path, text).',
      '  "forms"  — list AcroForm fields (path).',
      '  "fill"   — fill form fields (path, output_path, data).',
      "",
      'Pages are 1-based and accept ranges: "1-3,7". Hand a result over with present_deliverable.',
      "Every path here may be relative — it resolves against the workspace directory.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "reprint",
            "read",
            "tables",
            "info",
            "merge",
            "split",
            "rotate",
            "stamp",
            "forms",
            "fill",
          ],
        },
        path: { type: "string", description: "The PDF to read or change." },
        html_path: {
          type: "string",
          description:
            "reprint: the document's HTML source, e.g. report-source/document.html.",
        },
        inputs: {
          type: "array",
          items: { type: "string" },
          description: "merge: the PDFs to join, in order.",
        },
        output_path: {
          type: "string",
          description: "Where to write the result.",
        },
        output_dir: {
          type: "string",
          description: "split: the directory for the pieces.",
        },
        pages: {
          type: "string",
          description: 'Page selection, 1-based, e.g. "1-3,7".',
        },
        ranges: {
          type: "string",
          description: 'split: comma-separated ranges, e.g. "1-3,4-9".',
        },
        degrees: { type: "number", description: "rotate: 90, 180 or 270." },
        text: { type: "string", description: "stamp: the watermark text." },
        data: { type: "object", description: "fill: field name to value." },
      },
      required: ["action"],
    },
  },
  serve: {
    description: [
      "Serve a directory over http and get back a URL, so a web page you wrote can actually",
      "be opened. Static files only — html, css, js, images.",
      "",
      "Use it the moment you have written a page the user is meant to look at. `bash` cannot",
      "do this: it runs a command to completion, so a dev server started there is killed as",
      "soon as it reports being ready, and the URL answers nothing.",
      "",
      "Then hand the URL to present_deliverable — that is what opens the preview pane. A URL",
      "in prose is not previewed and not recorded.",
      "",
      "Actions:",
      '  "start" — serve a directory (directory). Serving it again returns the same URL.',
      '  "stop"  — stop serving one (directory).',
      '  "list"  — what is being served right now.',
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "stop", "list"],
          description: "What to do.",
        },
        directory: {
          type: "string",
          description:
            "The directory to serve. A relative path resolves against the workspace directory.",
        },
      },
      required: ["action"],
    },
  },
  present_deliverable: {
    description: [
      "Hand the finished work over. Call this at the end of a turn that produced files,",
      "listing what the user asked for — most important first.",
      "",
      "The items become a files card in the chat and are filed as artifacts; in a session",
      "the first one also opens in the preview pane. Naming a path in prose does none of",
      "that, and a file written with `bash` is not recorded anywhere unless it is declared",
      "here. To hand a file to a person on a messaging channel, use send_chat_message with",
      "attachment_path as well.",
      "",
      "List the deliverables, not the workings: the report, not the six scratch files it",
      "was assembled from.",
      "",
      "Call it again whenever the user asks to see, show, open, or look at something you",
      "already made. The pane may have been closed or the app restarted since, and this is",
      "the only way to put the file back on screen — describing it, or rendering its pages",
      "into the chat, does not show it. Presenting the same file twice is cheap and safe.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description:
            "The deliverables, most important first. The first one is opened in the preview pane.",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description:
                  "Path to the file, or an http(s) URL (a served app). A relative path resolves against " +
                  "the workspace directory. Files must exist — this reports the ones that do not.",
              },
              label: {
                type: "string",
                description:
                  'Short human name, e.g. "Q3 deck (PDF)". Defaults to the file name.',
              },
            },
            required: ["path"],
          },
        },
        summary: {
          type: "string",
          description: "One line about what was produced.",
        },
      },
      required: ["items"],
    },
  },
  deck_export_pdf: {
    description:
      "Render an HTML slide deck to PDF, one page per slide at the deck's own size. Use after building a deck from the Slide decks skill. Returns the PDF path and the page count.",
    inputSchema: {
      type: "object",
      properties: {
        html_path: {
          type: "string",
          description: "Path to the deck's HTML file.",
        },
        output_path: {
          type: "string",
          description:
            "Where to write the PDF. Defaults to the HTML path with a .pdf suffix.",
        },
        width_px: {
          type: "number",
          description: "Overrides the detected slide width, in CSS pixels.",
        },
        height_px: {
          type: "number",
          description: "Overrides the detected slide height, in CSS pixels.",
        },
      },
      required: ["html_path"],
    },
  },
  send_chat_message: {
    description: [
      "Send a message to a person or chat on a connected messaging platform.",
      "",
      "On WhatsApp this sends from the USER'S OWN account — the recipient sees it as them.",
      "Telegram and Discord send as the user's bot. Either way you are messaging a",
      "real person on their behalf: ONLY send when the user asked you to in this",
      "conversation, only what they asked, to who they asked — never on your own",
      "initiative — and quote the message back to them if there is any doubt.",
      "",
      '"to" can be a contact NAME ("Mom", "Ravi") — it resolves against the known contacts',
      "and errors if the name is ambiguous or unknown — or a chat id from list_chats, or on",
      'WhatsApp a phone number in international format (e.g. "+14155551234"). It can also be',
      '"me", which the platform resolves to the user\'s own account — so a message to',
      "themselves needs no number from them.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          enum: ["whatsapp", "telegram", "discord"],
        },
        to: {
          type: "string",
          description:
            "A contact name, a chat id from list_chats, or a phone number for WhatsApp.",
        },
        message: { type: "string", description: "The text to send." },
        attachment_path: {
          type: "string",
          description:
            "Absolute path of a file to send with the message (the message becomes its caption). Up to 25MB.",
        },
      },
      required: ["platform", "to", "message"],
    },
  },
  connect_connector: {
    description: [
      "The user's connectors — Slack, Gmail, Calendar, Drive and the rest — and the",
      "way to get one connected without ending the turn.",
      "",
      "The chat apps — WhatsApp, Telegram and Discord — are in this list",
      "too, with whether they are linked, and asking for one puts the same Connect",
      "button in the chat. Linking one opens its own sign-in, usually a QR code the",
      "user scans with their phone, so the call waits longer than most.",
      "",
      "Call it with no arguments to see every connector on this machine, each marked",
      "connected or not, and each connected one named with the account behind it —",
      'that account is who the user means by "me", so read it here instead of asking.',
      "Call it with a service to ask for that one: the user gets a",
      "Connect button in the chat and this call waits for them, then tells you what",
      "happened. Every connector is available to every chat — do not report that you",
      "cannot do something for want of a connector until you have asked for it this way.",
      "",
      "When the task plainly needs a missing service, call this immediately — the",
      "button is the question. Do not ask permission first, do not offer",
      '"connect X" as one item in a menu, and do not end the turn saying something',
      "is missing without the button already up.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description:
            'The service to ask for, e.g. "slack". Omit to list what exists.',
        },
        reason: {
          type: "string",
          description:
            "One line on why you need it, shown to the user under the button.",
        },
      },
    },
  },
  my_activity: {
    description: [
      "Your own recent activity, across YOUR other conversations: your main",
      "chat with the user, your auto-reply chats, and your routine runs.",
      'Call it when the user asks what you have done, or when "so far"',
      "plainly reaches beyond this conversation — this chat's context does",
      "not follow you between conversations, but your work does.",
    ].join("\n"),
    inputSchema: { type: "object", properties: {} },
  },
  disconnect_connector: {
    description: [
      "Disconnect one connector, when the user asks for that: an account",
      "connector (Gmail, Google Calendar, Drive, ...) is detached from their",
      "account; a chat app (WhatsApp, Telegram, Discord) is switched off.",
      "",
      "Only ever on the user's explicit request — never disconnect anything on",
      "your own judgement. It undoes cleanly: connect_connector reattaches an",
      "account connector, and switches a chat app back on. Before disconnecting",
      "something a routine of yours depends on, say what will break.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description:
            'The service to disconnect, e.g. "googlecalendar" or "whatsapp".',
        },
      },
      required: ["service"],
    },
  },
  list_chats: {
    description:
      "The cross-platform overview: which messaging platforms are connected, who the user " +
      "is on each, and a capped sample of contacts. For a platform's contacts use its own " +
      "tool — list_whatsapp_chats, list_telegram_chats, list_discord_chats " +
      "— where nothing from another platform can crowd them out. Lists the synced " +
      "address book plus everyone who has messaged in — with the chat id to reach them. " +
      "Pass a query to search by name, or a platform to list that platform's chats on " +
      "their own — output is capped, with a share kept for every platform, and it says " +
      "how many more each platform has. A platform missing from the rows is NOT a platform " +
      "with no chats: scope to it before concluding that. The user's own " +
      'account is listed too, marked (the user — "me"): that is who they mean by "me" or ' +
      '"myself", so never ask them for their own number. It also says when a platform is ' +
      "connected but not reachable right now, which is why a list can come back empty.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Name to search for, e.g. "mom". A name that matches a contact ' +
            "exactly lists only that contact — that is who a send goes to. " +
            "Omit to list.",
        },
        platform: {
          type: "string",
          enum: ["whatsapp", "telegram", "discord"],
          description:
            "List only this platform's chats — the way to see a small platform in full.",
        },
      },
    },
  },
  list_whatsapp_chats: {
    description:
      "List the user's WhatsApp chats and contacts — this platform only, with the `to:` " +
      "value to reach each. Use this rather than list_chats when the user means WhatsApp: " +
      "one platform's address book can never crowd another's out here. Pass a query to " +
      "search by name. On WhatsApp, a contact's or group's name IS its chat id, so the `to:` value is the name; a phone number in international format also works. " +
      "Pass `only_unread` to list just the chats and groups with messages waiting, each with " +
      'its unread count — the answer to "which groups have new messages?".',
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Name to search for, e.g. "mom". A name that matches a contact ' +
            "exactly lists only that contact — that is who a send goes to. " +
            "Omit to list.",
        },
        only_unread: {
          type: "boolean",
          description:
            "Only chats with unread messages, with the count for each, read " +
            "live from WhatsApp. Reading the counts does not mark anything read.",
        },
      },
    },
  },
  list_telegram_chats: {
    description:
      "List the user's Telegram chats and contacts — this platform only, with the `to:` " +
      "value to reach each. Use this rather than list_chats when the user means Telegram: " +
      "one platform's address book can never crowd another's out here. Pass a query to " +
      "search by name. On Telegram, the `to:` value is the chat id shown.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Name to search for, e.g. "mom". A name that matches a contact ' +
            "exactly lists only that contact — that is who a send goes to. " +
            "Omit to list.",
        },
      },
    },
  },
  list_discord_chats: {
    description:
      "List the user's Discord chats and contacts — this platform only, with the `to:` " +
      "value to reach each. Use this rather than list_chats when the user means Discord: " +
      "one platform's address book can never crowd another's out here. Pass a query to " +
      "search by name. On Discord, the `to:` value is the DM or `guild/channel` id shown; names are usernames, not display names.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Name to search for, e.g. "mom". A name that matches a contact ' +
            "exactly lists only that contact — that is who a send goes to. " +
            "Omit to list.",
        },
      },
    },
  },
  send_whatsapp_message: {
    description: [
      "Send a message to a person or chat on WhatsApp.",
      "",
      'Sends from the USER\'S OWN WhatsApp account — the recipient sees it as them. `to` is a contact or group NAME as WhatsApp shows it (the name IS the chat id), a phone number in international format ("+14155551234"), or "me" for the user\'s own chat.',
      "",
      "You are messaging a real person on the user's behalf: ONLY send when the user",
      "asked you to in this conversation, only what they asked, to who they asked —",
      "never on your own initiative — and quote the message back to them if there is",
      "any doubt. A name that is ambiguous or unknown errors rather than guessing.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Who to send to, on WhatsApp — see the description.",
        },
        message: { type: "string", description: "The text to send." },
      },
      required: ["to", "message"],
    },
  },
  read_whatsapp_messages: {
    description: [
      "Read recent WhatsApp messages — what came in and what was sent — newest",
      "last. Read-only, and only when the user asks you to check their messages;",
      "do not poll it on your own.",
      "",
      "Two ways in. `chat_id` reads ONE chat by its name or id. `query` finds",
      "messages CONTAINING words — a topic, a place, a thing, something someone",
      'said ("taco bell", "the invoice") — across chats, through the platform\'s',
      "own search; use it whenever the user names something that is not a",
      "contact. Without `query`, this covers messages received while the app has",
      "been running, not the full history. `query` searches WhatsApp's own full history — archived chats and unsaved numbers included.",
      "",
      "`only_unread` reads what is waiting: every chat with unread messages, and",
      'the newest messages in each, up to its unread count. Use it for "what did',
      'I miss?" and "any new messages?". Reading does not mark anything read.',
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        chat_id: {
          type: "string",
          description:
            "Only this chat (a `to:` value from list_whatsapp_chats). Omit for all.",
        },
        query: {
          type: "string",
          description:
            "Find messages CONTAINING this text; follow up with chat_id to read the whole thread.",
        },
        only_unread: {
          type: "boolean",
          description:
            "The unread messages across chats, grouped by chat, read live " +
            "from WhatsApp. Ignores chat_id and query.",
        },
        limit: {
          type: "number",
          description: "Most recent N messages. Default 50.",
        },
      },
    },
  },
  whatsapp_auto_reply: {
    description: [
      "Make this bot answer WhatsApp messages from chosen people automatically.",
      "Only works in a bot's own chat.",
      "",
      'Actions: "on" (start answering; optional sender to allow in the same call),',
      '"allow_sender" (sender), "remove_sender" (sender), "off" (stop answering),',
      '"status".',
      "",
      "Once on, each allowed sender gets a separate conversation where you answer",
      "them; everything written there is delivered to them, as the user. Replies go out from the user's own WhatsApp account.",
      "This chat stays the user's own. Anyone not allowed is only logged — never",
      "answered. Senders resolve by name against WhatsApp's contacts and people who",
      "have messaged before; if a name does not resolve, ask the user for the exact",
      "contact name, or have that person send one message and allow them from the log.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["on", "off", "allow_sender", "remove_sender", "status"],
        },
        sender: {
          type: "string",
          description: "The person, by contact name (or id) on WhatsApp.",
        },
      },
      required: ["action"],
    },
  },
  send_telegram_message: {
    description: [
      "Send a message to a person or chat on Telegram.",
      "",
      "Sends as the user's Telegram bot. `to` is a contact name or a chat id from list_telegram_chats, or \"me\" for the user's own chat with the bot.",
      "",
      "You are messaging a real person on the user's behalf: ONLY send when the user",
      "asked you to in this conversation, only what they asked, to who they asked —",
      "never on your own initiative — and quote the message back to them if there is",
      "any doubt. A name that is ambiguous or unknown errors rather than guessing.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Who to send to, on Telegram — see the description.",
        },
        message: { type: "string", description: "The text to send." },
      },
      required: ["to", "message"],
    },
  },
  read_telegram_messages: {
    description: [
      "Read recent Telegram messages — what came in and what was sent — newest",
      "last. Read-only, and only when the user asks you to check their messages;",
      "do not poll it on your own.",
      "",
      "Two ways in. `chat_id` reads ONE chat by its name or id. `query` finds",
      "messages CONTAINING words — a topic, a place, a thing, something someone",
      'said ("taco bell", "the invoice") — across chats, through the platform\'s',
      "own search; use it whenever the user names something that is not a",
      "contact. Without `query`, this covers messages received while the app has",
      "been running, not the full history. `query` searches through Telegram's own search.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        chat_id: {
          type: "string",
          description:
            "Only this chat (a `to:` value from list_telegram_chats). Omit for all.",
        },
        query: {
          type: "string",
          description:
            "Find messages CONTAINING this text; follow up with chat_id to read the whole thread.",
        },
        limit: {
          type: "number",
          description: "Most recent N messages. Default 50.",
        },
      },
    },
  },
  telegram_auto_reply: {
    description: [
      "Make this bot answer Telegram messages from chosen people automatically.",
      "Only works in a bot's own chat.",
      "",
      'Actions: "on" (start answering; optional sender to allow in the same call),',
      '"allow_sender" (sender), "remove_sender" (sender), "off" (stop answering),',
      '"status".',
      "",
      "Once on, each allowed sender gets a separate conversation where you answer",
      "them; everything written there is delivered to them, as the user. Replies go out as the user's Telegram bot.",
      "This chat stays the user's own. Anyone not allowed is only logged — never",
      "answered. Senders resolve by name against Telegram's contacts and people who",
      "have messaged before; if a name does not resolve, ask the user for the exact",
      "contact name, or have that person send one message and allow them from the log.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["on", "off", "allow_sender", "remove_sender", "status"],
        },
        sender: {
          type: "string",
          description: "The person, by contact name (or id) on Telegram.",
        },
      },
      required: ["action"],
    },
  },
  send_discord_message: {
    description: [
      "Send a message to a person or chat on Discord.",
      "",
      "Sends as the user's Discord account. `to` is a DM id or a `guild/channel` id from list_discord_chats, or a username; display names are not ids. \"me\" reaches the user too: it is delivered through the Abacus AI bot's DM when that is linked.",
      "",
      "You are messaging a real person on the user's behalf: ONLY send when the user",
      "asked you to in this conversation, only what they asked, to who they asked —",
      "never on your own initiative — and quote the message back to them if there is",
      "any doubt. A name that is ambiguous or unknown errors rather than guessing.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Who to send to, on Discord — see the description.",
        },
        message: { type: "string", description: "The text to send." },
      },
      required: ["to", "message"],
    },
  },
  read_discord_messages: {
    description: [
      "Read recent Discord messages — what came in and what was sent — newest",
      "last. Read-only, and only when the user asks you to check their messages;",
      "do not poll it on your own.",
      "",
      "Two ways in. `chat_id` reads ONE chat by its name or id. `query` finds",
      "messages CONTAINING words — a topic, a place, a thing, something someone",
      'said ("taco bell", "the invoice") — across chats, through the platform\'s',
      "own search; use it whenever the user names something that is not a",
      "contact. Without `query`, this covers messages received while the app has",
      "been running, not the full history. `query` runs per server: pass chat_id (a server or chat) to scope it; without one the joined servers are searched in order, capped at a few. Reads open the channel and can take a while; a read that would queue behind others is refused at once with the stored copy as the fallback.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        chat_id: {
          type: "string",
          description:
            "Only this chat (a `to:` value from list_discord_chats). Omit for all.",
        },
        query: {
          type: "string",
          description:
            "Find messages CONTAINING this text; follow up with chat_id to read the whole thread.",
        },
        limit: {
          type: "number",
          description: "Most recent N messages. Default 50.",
        },
      },
    },
  },
  discord_auto_reply: {
    description: [
      "Make this bot answer Discord messages from chosen people automatically.",
      "Only works in a bot's own chat.",
      "",
      'Actions: "on" (start answering; optional sender to allow in the same call),',
      '"allow_sender" (sender), "remove_sender" (sender), "off" (stop answering),',
      '"status".',
      "",
      "Once on, each allowed sender gets a separate conversation where you answer",
      "them; everything written there is delivered to them, as the user. Replies go out as the user's Discord account.",
      "This chat stays the user's own. Anyone not allowed is only logged — never",
      "answered. Senders resolve by name against Discord's contacts and people who",
      "have messaged before; if a name does not resolve, ask the user for the exact",
      "contact name, or have that person send one message and allow them from the log.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["on", "off", "allow_sender", "remove_sender", "status"],
        },
        sender: {
          type: "string",
          description: "The person, by contact name (or id) on Discord.",
        },
      },
      required: ["action"],
    },
  },
  read_chat_messages: {
    description: [
      "Read recent messages from the user's connected messaging platforms — what came in",
      "and what was sent — newest last. Read-only, and only when the user asks you to",
      "check their messages; do not poll it on your own.",
      "",
      "Covers messages received while the app has been running, not the platform's full",
      "history — except `query`, which searches by content through the platform's own",
      "search (WhatsApp: full history, archived chats and unsaved numbers included).",
      "Use `query` when the user asks about a sender or topic that no chat is named",
      "after — a bank, a delivery, 'the message about X'. Incoming messages never start",
      "agent turns by themselves; this tool is how they get read.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          enum: ["whatsapp", "telegram", "discord"],
          description: "Only this platform. Omit for all.",
        },
        chat_id: {
          type: "string",
          description: "Only this chat (an id from list_chats). Omit for all.",
        },
        query: {
          type: "string",
          description:
            "Find messages CONTAINING this text. Returns the matching chats " +
            "with the matching snippet; follow up with chat_id to read the " +
            "whole thread. On Discord, search runs per server: pass chat_id " +
            "(a server or chat) to scope it; without one the joined servers " +
            "are searched in order, capped at a few.",
        },
        limit: {
          type: "number",
          description: "Most recent N messages. Default 50.",
        },
      },
    },
  },
  auto_reply: {
    description: [
      "Make this bot answer chat messages from chosen people automatically. Only works",
      "in a bot's own chat.",
      "",
      'Actions: "on" (start answering; optional sender to allow in the same call),',
      '"allow_sender" (sender, and platform when more than one is connected),',
      '"remove_sender" (sender, platform likewise), "off" (stop answering), "status".',
      "",
      "Once on, each allowed sender gets a separate conversation where you answer",
      "them; everything written there is delivered to them, as the user (on WhatsApp",
      "from the user's own account, elsewhere as their linked bot). This chat stays",
      "the user's own. Works on every connected platform. Anyone not allowed is only",
      "logged — never answered.",
      "",
      "Senders resolve by name against the platform's contacts and people who have",
      "messaged before. If a name does not resolve, ask the user for the exact contact",
      "name, or have that person send one message and allow them from the log.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["on", "off", "allow_sender", "remove_sender", "status"],
        },
        sender: {
          type: "string",
          description: "The person, by contact name (or id) on the platform.",
        },
        platform: {
          type: "string",
          enum: ["whatsapp", "telegram", "discord"],
          description:
            "Which platform the sender is on. Optional when only one is connected.",
        },
      },
      required: ["action"],
    },
  },
  ha_call_service: {
    description:
      "Call a Home Assistant service to change something. This affects real devices in the user's home — be sure before calling it.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "e.g. light" },
        service: { type: "string", description: "e.g. turn_on" },
        entity_id: { type: "string" },
        data: {
          type: "object",
          description: "Extra service data, e.g. brightness.",
        },
      },
      required: ["domain", "service"],
    },
  },
};

export interface McpAgentToolsServerOptions {
  skillsService: SkillsService;
  /** Re-read per request so toggles take effect live. */
  enabledToolsets: () => Set<string>;
  workspacePath: () => string | null;
  workspaceId?: () => string | null;
  /** `trigger` lets the run log tell "Run now" from the first fire at creation. */
  runCronJob?: (jobId: string, trigger?: "manual" | "create") => Promise<void>;
  /**
   * The bot whose chat this UI session is, or null. A bot scheduling its own
   * routine gets the fires delivered back into its chat.
   */
  botIdForSession?: (sessionId: string) => string | null;
  /**
   * The conversation a deliverable from this session belongs to, so the
   * renderer opens it in that pane and no other. Null for an unknown session.
   */
  conversationKeyForSession?: (sessionId: string) => ConversationKey | null;
  /** Set for the turn behind a routine page's composer; it sees only cron. */
  routineEditorFor?: (sessionId: string) => string | null;
  /** Every conversation a bot owns, with its agent log; for my_activity. */
  ownActivity?: (botId: string) => Array<{
    sessionId: string;
    label: string;
    role: "forever" | "sender" | "routine";
    file: string | null;
  }>;
  onCronChanged?: () => void;
  /** Optional: a headless construction has none, and the tools withhold. */
  messaging?: {
    /** Platforms with a connector object; weaker than `livePlatforms`. */
    runningPlatforms: () => MessagingPlatformId[];
    /** Platforms whose connection is up, not merely started. */
    livePlatforms?: () => MessagingPlatformId[];
    /** The chat id meaning "me" on each platform. */
    selfChats?: () => Array<{ platform: MessagingPlatformId; chatId: string }>;
    selfPending?: () => MessagingPlatformId[];
    startingPlatforms?: () => MessagingPlatformId[];
    /** Bounded. */
    awaitReady?: (platform?: MessagingPlatformId) => Promise<void>;
    disablePlatform?: (id: MessagingPlatformId) => Promise<void>;
    /** Capped. */
    listChats: (
      query?: string,
      platform?: MessagingPlatformId
    ) => Array<{
      platform: MessagingPlatformId;
      chatId: string;
      name: string;
      status: "pending" | "approved" | "paused";
    }>;
    /** Preferred: also says how many rows the cap hid per platform. */
    listChatsDetailed?: (
      query?: string,
      platform?: MessagingPlatformId
    ) => {
      rows: Array<{
        platform: MessagingPlatformId;
        chatId: string;
        name: string;
        status: "pending" | "approved" | "paused";
      }>;
      hidden: Partial<Record<MessagingPlatformId, number>>;
    };
    send: (
      platform: MessagingPlatformId,
      chatId: string,
      text: string
    ) => Promise<void>;
    /** Throws where unsupported. */
    sendFile?: (
      platform: MessagingPlatformId,
      chatId: string,
      filePath: string,
      caption?: string
    ) => Promise<void>;
    /** Oldest first. */
    readMessages: (filter?: {
      platform?: MessagingPlatformId;
      chatId?: string;
      limit?: number;
    }) => Promise<
      Array<{
        platform: MessagingPlatformId;
        chatId: string;
        userId: string;
        userName: string | null;
        text: string;
        direction: "in" | "out";
        at: string;
      }>
    >;
    /** Null when the platform cannot say at all; throws when it cannot now. */
    unreadChats?: (platform: MessagingPlatformId) => Promise<Array<{
      chatId: string;
      name: string;
      unreadCount: number;
    }> | null>;
    autoReply?: {
      status: () => {
        respondToInbound: boolean;
        botId: string | null;
        approved: Array<{
          platform: MessagingPlatformId;
          userId: string;
          name: string;
        }>;
        pending: Array<{
          platform: MessagingPlatformId;
          userId: string;
          name: string;
        }>;
      };
      enable: (botId: string) => void;
      disable: () => void;
      senderCandidates: (platform?: MessagingPlatformId) => SenderCandidate[];
      /** The calling bot becomes the one that answers this sender. */
      allowSender: (candidate: SenderCandidate, botId?: string) => void;
      removeSender: (candidate: SenderCandidate) => void;
    };
  };
  /** Optional: headless has no account, and the tool reports unconfigured. */
  connectors?: {
    list: () => Promise<{
      available: { service: string; name: string }[];
      connected: string[];
      /** service -> who it is connected as, when the platform says. */
      accounts?: Record<string, string>;
    }>;
    /** Resolves once the user answers. */
    request: (input: {
      service: string;
      label: string;
      reason?: string;
      /** The conversation that asked, so the button appears only in it. */
      conversationKey: ConversationKey;
    }) => Promise<string>;
    /** Resolves to null or an error sentence. */
    disconnect?: (service: string) => Promise<string | null>;
  };
}

/**
 * Not read from the platform catalog: that carries i18n keys and the main
 * process has no translator.
 */
const CHAT_APP_LABELS: Record<MessagingPlatformId, string> = {
  telegram: "Telegram",
  discord: "Discord",
  whatsapp: "WhatsApp",
  abacus_discord: "Discord (Abacus AI bot)",
  abacus_telegram: "Telegram (Abacus AI bot)",
};

export class McpAgentToolsServer {
  private server: http.Server | null = null;
  private port: number | null = null;
  private activeSessions = new Map<string, { res: http.ServerResponse }>();
  private sessionCounter = 0;

  constructor(private readonly options: McpAgentToolsServerOptions) {}

  async start(): Promise<number> {
    if (this.server != null) return this.port!;

    const port = await this.findAvailablePort();
    this.port = port;
    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    return new Promise((resolve, reject) => {
      this.server!.listen(port, "127.0.0.1", () => resolve(port));
      this.server!.on("error", reject);
    });
  }

  stop(): void {
    for (const [, session] of this.activeSessions) {
      try {
        session.res.end();
      } catch {
        /* already closed */
      }
    }
    this.activeSessions.clear();

    if (this.server != null) {
      this.server.close();
      this.server = null;
      this.port = null;
    }
  }

  /**
   * Push `notifications/tools/list_changed` to every connected client so an
   * open conversation re-runs `tools/list`: a platform's tools appear the
   * moment it connects. Paired with `listChanged: true` in the initialize
   * capabilities, which a client checks before it listens.
   */
  notifyToolListChanged(): void {
    const frame = `event: message\ndata: ${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    })}\n\n`;
    for (const [, session] of this.activeSessions) {
      try {
        session.res.write(frame);
      } catch {
        /* closed; its own close handler drops it from the map */
      }
    }
  }

  getPort(): number | null {
    return this.port;
  }
  isRunning(): boolean {
    return this.server != null;
  }

  /** The always-on tools guarantee this. */
  hasEnabledTools(): boolean {
    if (ALWAYS_ENABLED.size > 0) return true;

    const enabled = this.options.enabledToolsets();

    return Object.keys(TOOL_TOOLSET).some((name) =>
      isToolEnabled(name, enabled)
    );
  }

  private async findAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address() as net.AddressInfo;
        srv.close(() => resolve(addr.port));
      });
      srv.on("error", reject);
    });
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);

    // No CORS headers on purpose: a wildcard origin would let any page the
    // user browsed call tools/call on loopback.
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      // Per-boot bearer token from the runtime MCP config; a browser gets 401.
      if (
        req.headers.authorization !==
        `Bearer ${localMcpServerToken(SERVER_NAME)}`
      ) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32000, message: "Unauthorized" },
          })
        );
        return;
      }
      if (req.method === "GET") this.handleSseConnection(res);
      else if (req.method === "POST") this.handleJsonRpcPost(req, res);
      else if (req.method === "DELETE") this.handleSessionDelete(req, res);
      else {
        res.writeHead(405);
        res.end();
      }
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          server: SERVER_NAME,
          version: SERVER_VERSION,
        })
      );
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private handleSseConnection(res: http.ServerResponse): void {
    const sessionId = `session-${++this.sessionCounter}`;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: endpoint\ndata: /mcp?sessionId=${sessionId}\n\n`);
    this.activeSessions.set(sessionId, { res });
    res.on("close", () => {
      this.activeSessions.delete(sessionId);
    });
  }

  private handleJsonRpcPost(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      // Malformed JSON is a Parse error (-32700); a handler that threw is an
      // Internal error (-32603) carrying the request id and message.
      let request: JsonRpcRequest;

      try {
        request = JSON.parse(body) as JsonRpcRequest;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          })
        );
        return;
      }

      try {
        const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);
        // The runtime MCP config URL carries the UI session id, which is how
        // a tool knows which conversation is asking.
        const callerSession = url.searchParams.get("session") ?? undefined;
        const response = await this.processJsonRpc(request, callerSession);
        const sessionId = url.searchParams.get("sessionId");

        if (sessionId != null && this.activeSessions.has(sessionId)) {
          const session = this.activeSessions.get(sessionId)!;
          try {
            session.res.write(
              `event: message\ndata: ${JSON.stringify(response)}\n\n`
            );
          } catch {
            /* closed */
          }
          res.writeHead(202);
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        }
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id ?? null,
            error: {
              code: -32603,
              message: `Internal error: ${error instanceof Error ? error.message : String(error)}`,
            },
          })
        );
      }
    });
  }

  private handleSessionDelete(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);
    const sessionId = url.searchParams.get("sessionId");

    if (sessionId != null) {
      const session = this.activeSessions.get(sessionId);
      if (session != null) {
        try {
          session.res.end();
        } catch {
          /* ignore */
        }
        this.activeSessions.delete(sessionId);
      }
    }

    res.writeHead(200);
    res.end();
  }

  private async processJsonRpc(
    request: JsonRpcRequest,
    callerSession?: string
  ): Promise<JsonRpcResponse> {
    const { method, params, id } = request;

    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        };
      case "notifications/initialized":
        return { jsonrpc: "2.0", id: id ?? null, result: {} };
      case "tools/list": {
        const enabled = this.options.enabledToolsets();
        const forBot = this.isBotCaller(callerSession);
        const forEditor = this.isRoutineEditor(callerSession);

        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            tools: Object.entries(TOOLS_SCHEMA)
              .filter(([name]) =>
                forEditor
                  ? name === "cronjob"
                  : this.isListed(name, enabled, forBot)
              )
              .map(([name, schema]) => ({
                name,
                description: schema.description,
                inputSchema: schema.inputSchema,
              })),
          },
        };
      }
      case "tools/call": {
        const toolName = (params as { name?: string })?.name ?? "";
        const toolArgs = ((params as { arguments?: Record<string, unknown> })
          ?.arguments ?? {}) as Record<string, unknown>;

        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: await this.executeTool(toolName, toolArgs, callerSession),
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id: id ?? null, result: {} };
      default:
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  }

  /** The editor turn behind a routine page's composer. */
  private isRoutineEditor(callerSession?: string): boolean {
    if (callerSession == null) return false;
    return this.options.routineEditorFor?.(callerSession) != null;
  }

  /**
   * Is the caller a bot's chat rather than a session? An absent session
   * counts as a session: the restricted answer is the safe one.
   */
  private isBotCaller(callerSession?: string): boolean {
    if (callerSession == null) return false;

    return this.options.botIdForSession?.(callerSession) != null;
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    callerSession?: string
  ): Promise<ToolResult> {
    const toolsets = toolsetsFor(name);

    if (!isKnownTool(name)) return this.err(`Unknown tool: ${name}`);

    // Re-checked at call time: a toolset switched off mid-session must stop
    // working even while the model holds an older tool list.
    const forEditor = this.isRoutineEditor(callerSession);
    if (forEditor && name !== "cronjob")
      return this.err("This session can only change its routine.");
    if (
      !forEditor &&
      !isToolEnabled(name, this.options.enabledToolsets()) &&
      !(BOT_ALWAYS.has(name) && this.isBotCaller(callerSession))
    ) {
      return this.err(
        `The ${toolsets.join("/")} toolset is switched off in Capabilities.`
      );
    }

    // Re-checked at call time for the same reason as the toolset gate above.
    if (BOTS_ONLY.has(name) && !this.isBotCaller(callerSession)) {
      return this.err(
        `${name} is only available in a bot's chat. Carry on and use your best judgement.`
      );
    }

    try {
      switch (name) {
        case "skills_list":
          return await this.skillsList();
        case "skill_view":
          return await this.skillView(String(args.id ?? ""));
        case "skill_manage":
          return await this.skillManage(String(args.id ?? ""));
        case "todo":
          return this.todo(args);
        case "memory":
          return await this.memory(args);
        case "cronjob":
          return await this.cronjob(args, callerSession);
        case "vision_analyze":
          return await this.analyze(args, "image");
        case "video_analyze":
          return await this.analyze(args, "video");
        case "image_generate":
          return await this.imageGenerate(args);
        case "text_to_speech":
          return await this.textToSpeech(args);
        case "deck_export_pdf":
          return await this.deckExportPdf(args);
        case "pdf":
          return await this.pdf(args);
        case "serve":
          return await this.serve(args);
        case "present_deliverable":
          return this.presentDeliverable(args, callerSession);
        case "bfl_flux3_prompting_guide":
          return this.ok(videoPromptingGuide());
        case "bfl_flux3_get_result":
          return await this.pollVideoJob(args);
        case "video_generate":
        case "xai_video_edit":
        case "xai_video_extend":
        case "bfl_flux3_text_to_video":
        case "bfl_flux3_image_to_video":
        case "bfl_flux3_keyframes_to_video":
        case "bfl_flux3_video_continuation":
          return await this.submitVideoJob(args);
        case "x_search":
          return await this.xSearch(args);
        case "send_chat_message":
          return await this.sendChatMessage(args);
        case "connect_connector":
          return await this.connectConnector(args, callerSession);
        case "disconnect_connector":
          return await this.disconnectConnector(args);
        case "my_activity":
          return this.myActivity(callerSession);
        case "list_chats":
          return await this.listChats(args);
        case "list_whatsapp_chats":
          return await this.listChats({ ...args, platform: "whatsapp" });
        case "list_telegram_chats":
          return await this.listChats({ ...args, platform: "telegram" });
        case "list_discord_chats":
          return await this.listChats({ ...args, platform: "discord" });
        case "send_whatsapp_message":
          return await this.sendChatMessage({ ...args, platform: "whatsapp" });
        case "read_whatsapp_messages":
          return await this.readChatMessages({ ...args, platform: "whatsapp" });
        case "whatsapp_auto_reply":
          return this.autoReply(
            { ...args, platform: "whatsapp" },
            callerSession
          );
        case "send_telegram_message":
          return await this.sendChatMessage({ ...args, platform: "telegram" });
        case "read_telegram_messages":
          return await this.readChatMessages({ ...args, platform: "telegram" });
        case "telegram_auto_reply":
          return this.autoReply(
            { ...args, platform: "telegram" },
            callerSession
          );
        case "send_discord_message":
          return await this.sendChatMessage({ ...args, platform: "discord" });
        case "read_discord_messages":
          return await this.readChatMessages({ ...args, platform: "discord" });
        case "discord_auto_reply":
          return this.autoReply(
            { ...args, platform: "discord" },
            callerSession
          );
        case "read_chat_messages":
          return await this.readChatMessages(args);
        case "auto_reply":
          return this.autoReply(args, callerSession);
        case "ha_list_entities":
        case "ha_get_state":
        case "ha_list_services":
        case "ha_call_service":
          return await this.homeAssistant(name, args);
        default:
          return this.err(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return this.err(error instanceof Error ? error.message : String(error));
    }
  }

  // ── Skills ───────────────────────────────────────────────────────────────

  private async skillsList(): Promise<ToolResult> {
    const workspacePath = this.options.workspacePath();
    const { skills } = await this.options.skillsService.listInstalled(
      workspacePath != null ? { workspacePath } : {}
    );

    if (skills.length === 0) return this.ok("No skills are installed.");

    return this.ok(
      skills
        .map(
          (skill) =>
            `${skill.id} [${skill.source}] — ${skill.description ?? "no description"}`
        )
        .join("\n")
    );
  }

  private async findSkill(
    id: string
  ): Promise<{ path: string; name: string } | null> {
    const workspacePath = this.options.workspacePath();
    const { skills } = await this.options.skillsService.listInstalled(
      workspacePath != null ? { workspacePath } : {}
    );
    const match = skills.find((skill) => skill.id === id);

    return match != null ? { path: match.path, name: match.name } : null;
  }

  private async skillView(id: string): Promise<ToolResult> {
    if (id.trim().length === 0) return this.err("A skill id is required.");

    const skill = await this.findSkill(id);

    if (skill == null)
      return this.err(
        `No skill with id "${id}". Run skills_list to see what is available.`
      );

    const fs = await import("fs");
    const target = fs.statSync(skill.path).isDirectory()
      ? path.join(skill.path, "SKILL.md")
      : skill.path;

    return this.ok(fs.readFileSync(target, "utf8"));
  }

  private async skillManage(id: string): Promise<ToolResult> {
    if (id.trim().length === 0) return this.err("A skill id is required.");

    const skill = await this.findSkill(id);

    if (skill == null) {
      // Creating a skill is a file write the agent can already do.
      const workspacePath = this.options.workspacePath();
      const suggestion =
        workspacePath != null
          ? path.join(
              workspacePath,
              WORKSPACE_DIR_NAME,
              "skills",
              `${id}`,
              "SKILL.md"
            )
          : `<workspace>/${WORKSPACE_DIR_NAME}/skills/${id}/SKILL.md`;

      return this.ok(
        `No skill "${id}" exists yet. To create one, write a SKILL.md at:\n${suggestion}`
      );
    }

    const fs = await import("fs");
    const target = fs.statSync(skill.path).isDirectory()
      ? path.join(skill.path, "SKILL.md")
      : skill.path;

    return this.ok(
      `${skill.name} lives at:\n${target}\n\nEdit it with the file tools.`
    );
  }

  // ── Task planning ────────────────────────────────────────────────────────

  private todo(args: Record<string, unknown>): ToolResult {
    const action = String(args.action ?? "");

    if (action === "list") return this.ok(renderTodos(readTodos()));

    if (action !== "set") return this.err('action must be "set" or "list".');

    const result = setTodos(args.todos);

    return result.ok
      ? this.ok(`${result.message}\n\n${renderTodos(result.items)}`)
      : this.err(result.message);
  }

  // ── Memory ───────────────────────────────────────────────────────────────

  private async memory(args: Record<string, unknown>): Promise<ToolResult> {
    const target = String(args.target ?? "") as MemoryTarget;
    const action = String(args.action ?? "") as MemoryAction;

    if (target !== "memory" && target !== "user")
      return this.err('target must be "memory" or "user".');
    if (action !== "add" && action !== "replace" && action !== "remove") {
      return this.err('action must be "add", "replace", or "remove".');
    }

    const result = await applyMemoryAction(target, action, {
      ...(typeof args.content === "string" ? { content: args.content } : {}),
      ...(typeof args.match === "string" ? { match: args.match } : {}),
    });

    const entries = result.entries ?? readEntries(target);
    const rendered =
      entries.length > 0
        ? entries.map((entry) => `- ${entry}`).join("\n")
        : "(empty)";

    return result.ok
      ? this.ok(
          `${result.message}\n\n${target === "user" ? "USER PROFILE" : "MEMORY"} now:\n${rendered}`
        )
      : this.err(result.message);
  }

  // ── Cron jobs ────────────────────────────────────────────────────────────

  /**
   * The first fire of a freshly created interval routine. Failure is
   * swallowed: the routine is saved, so this is a missed run, not a failed
   * create. The run log carries the reason.
   */
  private async fireOnCreate(jobId: string): Promise<boolean> {
    try {
      await this.options.runCronJob?.(jobId, "create");
      return true;
    } catch {
      return false;
    }
  }

  private async cronjob(
    args: Record<string, unknown>,
    callerSession?: string
  ): Promise<ToolResult> {
    const action = String(args.action ?? "");
    const id = typeof args.id === "string" ? args.id.trim() : "";

    try {
      if (action === "list") {
        const jobs = listJobs();
        // A bot sees its own routines, not the machine's, or it adopts the
        // user's unrelated schedules as its own backlog. The count says
        // others exist.
        const callerBot =
          callerSession != null
            ? (this.options.botIdForSession?.(callerSession) ?? null)
            : null;
        const visible =
          callerBot == null
            ? jobs
            : jobs.filter((job) => job.botId === callerBot);
        const others = jobs.length - visible.length;
        const suffix =
          callerBot != null && others > 0
            ? `\n\n(${others} other routine${others === 1 ? "" : "s"} belong to the user or other bots — not yours to run.)`
            : "";

        const none =
          callerBot == null ? "No routines yet." : "No routines of yours yet.";

        return this.ok(
          visible.length === 0
            ? `${none}${suffix}`
            : visible.map(describeJob).join("\n\n") + suffix
        );
      }

      if (action === "create") {
        const schedule = typeof args.schedule === "string" ? args.schedule : "";
        const prompt = typeof args.prompt === "string" ? args.prompt : "";
        const webhook = args.webhook === true;

        if (schedule.trim().length === 0 && !webhook)
          return this.err("A schedule or webhook: true is required.");

        // A bot scheduling from its own chat is the maker: the routine lists
        // as its own and runs in its voice, in a fresh session like any other.
        const botId =
          callerSession != null
            ? (this.options.botIdForSession?.(callerSession) ?? null)
            : null;

        const job = createJob({
          schedule: schedule.trim().length > 0 ? schedule : null,
          webhook,
          prompt,
          name: typeof args.name === "string" ? args.name : undefined,
          workspaceId: this.options.workspaceId?.() ?? null,
          botId,
        });
        this.options.onCronChanged?.();

        // Every routine runs once the moment it is set up: waiting for the
        // first tick leaves no way to tell one that works from one that
        // quietly does not.
        const firedNow =
          job.enabled &&
          job.schedule != null &&
          this.options.runCronJob != null &&
          (await this.fireOnCreate(job.id));

        const delivery =
          "It lives under Routines in the sidebar; each fire runs in a fresh session of its own, listed there with its outcome." +
          (botId != null
            ? " It speaks in your voice and counts as one of yours."
            : "");
        // The double-send guard: the fire is the demonstration, and the
        // creating agent must not also perform the task "to confirm it works".
        const first = firedNow
          ? " The first one is running now, without waiting for the next tick — " +
            "it performs the routine's task itself, so do NOT also do that " +
            "task (send the message, gather the summary) here: that would " +
            "reach the user twice. Just confirm the setup in a sentence."
          : "";
        const hook =
          job.webhookToken != null
            ? `\nIt can also be fired by POST to the webhook shown in the Routines panel.`
            : "";

        return this.ok(
          `Created. ${delivery}${first}${hook}\n\n${describeJob(job)}`
        );
      }

      if (id.length === 0)
        return this.err(
          `"${action}" needs an id. Use action "list" to see them.`
        );

      if (action === "remove") {
        removeJob(id);
        this.options.onCronChanged?.();

        return this.ok(`Removed ${id}.`);
      }

      if (action === "pause" || action === "resume") {
        const job = updateJob(id, { enabled: action === "resume" });
        this.options.onCronChanged?.();

        return this.ok(describeJob(job));
      }

      if (action === "update") {
        const changes: {
          schedule?: string;
          prompt?: string;
          enabled?: boolean;
          name?: string;
        } = {};

        if (
          typeof args.schedule === "string" &&
          args.schedule.trim().length > 0
        )
          changes.schedule = args.schedule;
        if (typeof args.prompt === "string" && args.prompt.trim().length > 0)
          changes.prompt = args.prompt;
        if (typeof args.enabled === "boolean") changes.enabled = args.enabled;
        // A repurposed routine must be renameable, or the model sees the
        // mismatch in every list it reads back and can do nothing about it.
        if (typeof args.name === "string" && args.name.trim().length > 0)
          changes.name = args.name;

        if (Object.keys(changes).length === 0)
          return this.err(
            "Nothing to update — give a schedule, a prompt, a name, or enabled."
          );

        const job = updateJob(id, changes);
        this.options.onCronChanged?.();

        return this.ok(describeJob(job));
      }

      if (action === "run") {
        const job = listJobs().find((entry) => entry.id === id);

        if (job == null) return this.err(`No job with id "${id}".`);

        if (this.options.runCronJob == null)
          return this.err(
            "Nothing is attached that can start a scheduled run."
          );

        await this.options.runCronJob(job.id);

        return this.ok(
          job.botId != null
            ? `Started ${id} now, in a fresh run listed under Routines — in your voice.`
            : `Started ${id} now, in a fresh run listed under Routines.`
        );
      }

      return this.err(`Unknown action "${action}".`);
    } catch (error) {
      return this.err(error instanceof Error ? error.message : String(error));
    }
  }

  // ── Vision and video analysis ────────────────────────────────────────────

  private async analyze(
    args: Record<string, unknown>,
    kind: "image" | "video"
  ): Promise<ToolResult> {
    const source = String(args.source ?? "").trim();

    if (source.length === 0)
      return this.err("A source path or URL is required.");

    const prompt =
      String(args.prompt ?? "").trim() ||
      (kind === "image"
        ? "Describe this image in detail."
        : "Describe what happens in this video.");

    const { provider, answer } = await analyze(source, prompt, kind);

    // No provider means setup guidance, not an answer; flag it as an error.
    if (provider == null) return this.err(answer);

    return this.ok(`${answer}\n\n(via ${provider})`);
  }

  // ── Components ───────────────────────────────────────────────────────────

  /**
   * A caller-supplied path made absolute against the workspace. Downstream
   * `path.resolve` uses the main process's cwd, `/` in a packaged app, and
   * the Artifacts view resolves against the workspace; only this matches both
   * what the user meant and what the rest of the app assumes.
   */
  private resolveOutputPath(raw: string): string {
    if (raw.length === 0) return raw;
    if (path.isAbsolute(raw)) return raw;
    const workspacePath = this.options.workspacePath();
    return workspacePath != null
      ? path.resolve(workspacePath, raw)
      : path.resolve(raw);
  }

  // ── Media generation ─────────────────────────────────────────────────────

  private async imageGenerate(
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    const prompt = String(args.prompt ?? "").trim();

    if (prompt.length === 0) return this.err("A prompt is required.");

    const size = typeof args.size === "string" ? args.size : undefined;
    const file = await generateImage(prompt, size);

    // Hand back markdown that renders inline, so showing the image is the
    // easy path rather than "here is the file".
    const alt = prompt
      .replace(/[\r\n[\]]/g, " ")
      .trim()
      .slice(0, 80);

    return this.ok(
      `Saved to ${file}\n\nShow it to the user with: ![${alt}](${fileUrl(file)})\n${artifactPathLine(file)}`
    );
  }

  private async textToSpeech(
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    const text = String(args.text ?? "").trim();

    if (text.length === 0) return this.err("There is no text to speak.");

    const voice = typeof args.voice === "string" ? args.voice : undefined;
    const file = await generateSpeech(text, voice);

    return this.ok(`Saved to ${file}\n${artifactPathLine(file)}`);
  }

  private async pdf(args: Record<string, unknown>): Promise<ToolResult> {
    const action = String(args.action ?? "").trim();
    const str = (key: string): string => String(args[key] ?? "").trim();

    try {
      if (action === "reprint") {
        // `path` is accepted too: the other actions all name their file so.
        const source =
          str("html_path").length > 0 ? str("html_path") : str("path");

        if (source.length === 0)
          return this.err(
            "reprint needs html_path: the document's HTML source."
          );

        const printed = await reprintPdf({
          htmlPath: this.resolveOutputPath(source),
          ...(str("output_path").length > 0
            ? { outputPath: this.resolveOutputPath(str("output_path")) }
            : {}),
        });

        return this.ok(
          [
            `Printed ${printed.htmlPath} — ${printed.pages} pages in ${printed.seconds}s: ${printed.pdfPath}`,
            ...(printed.previewPath != null
              ? [`Rendered page, as a PNG: ${printed.previewPath}`]
              : []),
            "",
            `Hand it over: present_deliverable with ${printed.pdfPath}`,
          ].join("\n")
        );
      }

      // Arguments are assembled rather than passed through so the tool
      // surface stays a fixed shape; paths are made absolute first because
      // the script runs with the app's cwd.
      const at = (key: string): string => this.resolveOutputPath(str(key));
      const byAction: Record<string, string[]> = {
        info: [at("path")],
        read: [at("path"), ...(str("pages") ? ["--pages", str("pages")] : [])],
        tables: [
          at("path"),
          ...(str("pages") ? ["--pages", str("pages")] : []),
        ],
        merge: [
          at("output_path"),
          ...(Array.isArray(args.inputs)
            ? args.inputs.map((input) =>
                this.resolveOutputPath(String(input).trim())
              )
            : []),
        ],
        split: [
          at("path"),
          at("output_dir"),
          ...(str("ranges") ? ["--ranges", str("ranges")] : []),
        ],
        rotate: [
          at("path"),
          at("output_path"),
          "--degrees",
          String(typeof args.degrees === "number" ? args.degrees : 90),
          ...(str("pages") ? ["--pages", str("pages")] : []),
        ],
        stamp: [at("path"), at("output_path"), "--text", str("text")],
        forms: [at("path")],
        // `data` may arrive as a JSON string; the script needs one encoding.
        fill: [
          at("path"),
          at("output_path"),
          "--data",
          JSON.stringify(
            typeof args.data === "string"
              ? (() => {
                  try {
                    return JSON.parse(args.data as string);
                  } catch {
                    return args.data;
                  }
                })()
              : (args.data ?? {})
          ),
        ],
      };

      const scriptArgs = byAction[action];
      if (scriptArgs == null) return this.err(`Unknown action "${action}".`);
      if (scriptArgs.some((value) => value.length === 0)) {
        return this.err(
          `The "${action}" action is missing a required path or value.`
        );
      }

      const result = await runPdfScript([action, ...scriptArgs]);
      if (result.ok !== true) {
        const install =
          typeof result.install === "string" ? ` Run: ${result.install}` : "";
        return this.err(`${result.error ?? "The operation failed."}${install}`);
      }

      const rendered = JSON.stringify(result, null, 2);

      return this.ok(
        rendered.length > 60_000
          ? `${rendered.slice(0, 60_000)}\n[output truncated]`
          : rendered
      );
    } catch (error) {
      return this.err(
        `The PDF operation failed: ${(error as Error)?.message ?? "unknown error"}`
      );
    }
  }

  private fileExists(candidate: string): boolean {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  }

  /**
   * Tell the renderer to show a path or URL in the pane of the conversation
   * that produced it, not whatever chat is on screen. A notification, not a
   * call: nothing here can know the pane rendered it, hence "sent".
   */
  private broadcastPreviewOpen(target: string, callerSession?: string): void {
    const conversationKey =
      callerSession == null
        ? null
        : (this.options.conversationKeyForSession?.(callerSession) ?? null);
    sendToRenderer(IpcChannels.Event, {
      type: "preview-open",
      path: target,
      ...(conversationKey == null ? {} : { conversationKey }),
      emittedAt: new Date().toISOString(),
    });
  }

  /**
   * The end-of-turn handover, as a markdown list so each deliverable is
   * clickable; the only record of a file written by `bash`. Missing files are
   * named and an empty result is an error: a success with nothing behind it
   * is worse than a failure the model can correct.
   */
  private async serve(args: Record<string, unknown>): Promise<ToolResult> {
    const action = String(args.action ?? "").trim();
    const directory = String(args.directory ?? "").trim();

    try {
      if (action === "list") {
        const served = listServed();

        return this.ok(
          served.length === 0
            ? "Nothing is being served."
            : JSON.stringify(served, null, 2)
        );
      }

      if (directory.length === 0) return this.err("A directory is required.");

      if (action === "stop") {
        return this.ok(
          stopDirectory(this.resolveOutputPath(directory))
            ? "Stopped."
            : "That directory was not being served."
        );
      }

      if (action === "start") {
        const served = await serveDirectory(this.resolveOutputPath(directory));
        // The page, not the folder, unless the folder has an index; a root
        // URL for a folder holding only `love.html` opens onto "Not found".
        const pages = await htmlPagesIn(served.directory);
        const entry =
          pages[0] === "index.html" || pages.length === 0
            ? served.url
            : pages.length === 1
              ? `${served.url}/${encodeURIComponent(pages[0]!)}`
              : null;

        return this.ok(
          [
            `Serving ${served.directory} at ${served.url}`,
            "",
            entry != null
              ? `Hand it over: present_deliverable with ${entry}`
              : `No index.html; the pages are ${pages
                  .map((page) => `${served.url}/${encodeURIComponent(page)}`)
                  .join(", ")}. Hand the right one to present_deliverable.`,
          ].join("\n")
        );
      }

      return this.err(`Unknown action "${action}".`);
    } catch (error) {
      return this.err(
        `Could not serve that directory: ${(error as Error)?.message ?? "unknown error"}`
      );
    }
  }

  private presentDeliverable(
    args: Record<string, unknown>,
    callerSession?: string
  ): ToolResult {
    const rawItems = Array.isArray(args.items) ? args.items : [];

    if (rawItems.length === 0)
      return this.err(
        "At least one item is required — each with a path or an http(s) URL."
      );

    const valid: Array<{ label: string; target: string; isUrl: boolean }> = [];
    const missing: string[] = [];

    for (const entry of rawItems) {
      const item = (
        typeof entry === "object" && entry != null ? entry : {}
      ) as Record<string, unknown>;
      const raw = String(item.path ?? "").trim();

      if (raw.length === 0) continue;

      const isUrl = /^https?:\/\//i.test(raw);
      const target = isUrl ? raw : this.resolveOutputPath(raw);

      // A URL cannot be stat'ed; a path is, so a bad one never reports as shown.
      if (!isUrl && !this.fileExists(target)) {
        missing.push(target);
        continue;
      }

      const label = String(item.label ?? "").trim();
      valid.push({
        label:
          label.length > 0 ? label : isUrl ? target : path.basename(target),
        target,
        isUrl,
      });
    }

    if (valid.length === 0) {
      const detail = missing.length > 0 ? `\n\n${missing.join("\n")}` : "";
      return this.err(
        `Nothing could be presented — none of those exist. Check the paths.${detail}`
      );
    }

    const first = valid[0]!;
    // Only the first item goes to the preview pane; the rest are rows of the
    // files card. A bot's turn opens nothing: a document jumping open over
    // the user's unrelated work reads as the app misbehaving.
    const forBot = this.isBotCaller(callerSession);
    if (!forBot) this.broadcastPreviewOpen(first.target, callerSession);

    const summary = String(args.summary ?? "").trim();
    const lines = [
      ...(summary.length > 0 ? [summary, ""] : []),
      ...valid.map(
        (item) =>
          `- [${item.label}](${item.isUrl ? item.target : fileUrl(item.target)})`
      ),
      "",
      forBot
        ? "Listed in the chat as a files card the user can open."
        : `Listed in the chat as a files card; ${first.label} was sent to the preview pane.`,
    ];

    if (missing.length > 0) {
      lines.push(
        "",
        `Not presented, because there is no file at these paths: ${missing.join(", ")}`
      );
    }

    return this.ok(lines.join("\n"));
  }

  private async deckExportPdf(
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    const htmlPath = String(args.html_path ?? "").trim();

    if (htmlPath.length === 0)
      return this.err("The path to the deck's HTML file is required.");

    const numeric = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : undefined;

    try {
      const result = await exportDeckPdf({
        htmlPath: this.resolveOutputPath(htmlPath),
        outputPath:
          typeof args.output_path === "string" &&
          args.output_path.trim().length > 0
            ? this.resolveOutputPath(args.output_path.trim())
            : undefined,
        widthPx: numeric(args.width_px),
        heightPx: numeric(args.height_px),
      });

      // A page count that disagrees with the slide count is a bad pagination.
      return this.ok(
        `Wrote ${result.pdfPath}\n${result.slides} slides at ${result.widthPx}x${result.heightPx}, ` +
          `${Math.round(result.bytes / 1024)} KB.\n\n` +
          "Read the PDF back and look at it before showing the user — overflowing text is obvious in the render and invisible in the markup."
      );
    } catch (error) {
      return this.err(
        `Could not export the deck: ${(error as Error)?.message ?? "unknown error"}`
      );
    }
  }

  private async submitVideoJob(
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    const prompt = String(args.prompt ?? "").trim();

    if (prompt.length === 0) return this.err("A prompt is required.");

    const keyframes = Array.isArray(args.keyframes)
      ? args.keyframes.map(String)
      : undefined;
    const imageUrl =
      typeof args.image_url === "string" ? args.image_url : undefined;
    const continueFrom =
      typeof args.video_url === "string" ? args.video_url : undefined;

    const jobId = await submitVideo({
      prompt,
      ...(imageUrl != null ? { imageUrl } : {}),
      ...(keyframes != null ? { keyframes } : {}),
      ...(continueFrom != null ? { continueFrom } : {}),
    });

    return this.ok(
      `Submitted as job ${jobId}. Generation takes minutes — check it with bfl_flux3_get_result, polling every 20-30 seconds rather than continuously.`
    );
  }

  private async pollVideoJob(
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    const jobId = String(args.job_id ?? "").trim();

    if (jobId.length === 0) return this.err("A job id is required.");

    const result = await pollVideo(jobId);

    if (!result.done) return this.ok(result.message);

    // The message is the file's path or the provider's error text, so the
    // artifact line is added only when it is a path that exists.
    const finished = result.message.trim();
    const isFile =
      path.isAbsolute(finished) &&
      !finished.includes("\n") &&
      this.fileExists(finished);

    return this.ok(
      `Done. ${result.message}${isFile ? `\n${artifactPathLine(finished)}` : ""}`
    );
  }

  /** See READINESS. An instance method because messaging readiness lives on the gateway. */
  private isToolConfigured(name: string): boolean {
    if (HIDDEN_FROM_MODEL.has(name)) {
      return (this.options.messaging?.runningPlatforms().length ?? 0) > 0;
    }
    // No Discord tools on a machine that never connected Discord.
    const platform = TOOL_PLATFORM[name];
    if (platform != null)
      return (
        this.options.messaging?.runningPlatforms().includes(platform) ?? false
      );
    return READINESS[name]?.() ?? true;
  }

  /** Whether `tools/list` shows a tool to this caller. */
  isListed(name: string, enabled: Set<string>, forBot: boolean): boolean {
    if (HIDDEN_FROM_MODEL.has(name)) return false;
    return (
      (isToolEnabled(name, enabled) || (forBot && BOT_ALWAYS.has(name))) &&
      this.isToolConfigured(name) &&
      (forBot || !BOTS_ONLY.has(name))
    );
  }

  /** For tests and diagnostics. */
  listedToolNames(forBot = false): string[] {
    const enabled = this.options.enabledToolsets();
    return Object.keys(TOOLS_SCHEMA).filter((name) =>
      this.isListed(name, enabled, forBot)
    );
  }

  // ── Messaging ────────────────────────────────────────────────────────────

  private messagingSetupHint(): ToolResult {
    return this.err(
      "No messaging platform is connected. Connect WhatsApp, Telegram or Discord from Settings → Connectors first."
    );
  }

  /**
   * The refusal to hand back, or null when the platform is linked. Judged by
   * `livePlatforms`, not `runningPlatforms`: a phone that unlinks leaves the
   * connector in place waiting for a fresh QR.
   */
  private notLinked(platform: MessagingPlatformId): ToolResult | null {
    const messaging = this.options.messaging;
    const live =
      messaging?.livePlatforms?.() ?? messaging?.runningPlatforms() ?? [];

    if (live.includes(platform)) return null;

    // Named, never a generic "no messaging is set up": the agent must tell
    // "WhatsApp is down" from "you have no platforms".
    return this.err(
      `${platform} is not connected right now, so nothing was sent. ` +
        "It may be linking or waiting for a QR scan. Do not retry, do not " +
        "send the user to Settings, and do not ask them for the number — " +
        `call connect_connector with service "${platform}": it puts a ` +
        "Connect button in front of the user right here and waits for them."
    );
  }

  private async sendChatMessage(
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    const messaging = this.options.messaging;
    if (messaging == null || messaging.runningPlatforms().length === 0)
      return this.messagingSetupHint();

    const platform = String(args.platform ?? "").trim();
    const to = String(args.to ?? "").trim();
    const message = String(args.message ?? "");
    const attachmentPath = String(args.attachment_path ?? "").trim();

    if (!isMessagingPlatformId(platform))
      return this.err(`Unknown platform "${platform}".`);
    // The platform being addressed, not "some platform is up".
    const unavailable = this.notLinked(platform);
    if (unavailable != null) return unavailable;
    if (to.length === 0) return this.err('"to" is required.');
    if (attachmentPath.length === 0 && message.trim().length === 0)
      return this.err("There is no message.");

    if (attachmentPath.length > 0) {
      if (messaging.sendFile == null)
        return this.err("Sending files is not wired up in this build.");
      let size: number;
      try {
        size = fs.statSync(attachmentPath).size;
      } catch {
        return this.err(`No file at ${attachmentPath}.`);
      }
      if (size > MAX_ATTACHMENT_BYTES)
        return this.err(
          `That file is ${Math.round(size / 1024 / 1024)}MB — the limit is ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB.`
        );
      await messaging.sendFile(
        platform,
        to,
        attachmentPath,
        message.trim().length > 0 ? message : undefined
      );

      return this.ok(`Sent the file to ${to} on ${platform}.`);
    }

    await messaging.send(platform, to, message);

    return this.ok(`Sent to ${to} on ${platform}.`);
  }

  /**
   * List the catalog, connected or not, so the agent can name what it lacks;
   * or ask, which blocks on the user's answer. The ask resolves display names
   * as well as ids, forgivingly: Gmail's id is `gmailuser`, and any name the
   * tool can print the model may ask for.
   */
  private async connectConnector(
    args: Record<string, unknown>,
    callerSession?: string
  ): Promise<ToolResult> {
    const connectors = this.options.connectors;
    if (connectors == null)
      return this.err("Connectors are not available in this session.");

    // A caller with no conversation gets no button: putting it "wherever the
    // user is" lands a bot's ask in a stranger's session.
    const conversationKey =
      callerSession == null
        ? null
        : (this.options.conversationKeyForSession?.(callerSession) ?? null);
    if (conversationKey == null)
      return this.err(
        "This call has no conversation to ask in, so no Connect button can be shown. " +
          "Tell the user which connector you need; they can connect it from Connectors."
      );

    const { available, connected, accounts } = await connectors.list();
    const isConnected = (service: string): boolean =>
      connected.includes(service);
    /** " (connected as Gmail - ada@example.com)", or "" when unknown. */
    const accountOf = (service: string): string => {
      const account = accounts?.[service];
      return account != null && account.length > 0 ? ` as ${account}` : "";
    };

    // The chat apps are connectors too but live in this app's own messaging
    // setup, not the account's catalog. Judged live, not merely running: an
    // unlinked phone leaves the connector object waiting for a QR.
    const liveChat =
      this.options.messaging?.livePlatforms?.() ??
      this.options.messaging?.runningPlatforms() ??
      [];
    const chatApps = AGENT_LINKABLE_CHAT_APPS.filter(
      // Nothing the catalog carries: its entries have tools behind them.
      (id) => !available.some((item) => item.service === id)
    ).map((id) => ({
      service: id,
      name: CHAT_APP_LABELS[id],
      live: liveChat.includes(id),
    }));
    const chatApp = (service: string): (typeof chatApps)[number] | undefined =>
      chatApps.find((entry) => entry.service === service.toLowerCase());

    const asked = String(args.service ?? "").trim();

    if (asked.length === 0) {
      if (available.length === 0) {
        return this.ok("No connectors are available on this machine.");
      }

      return this.ok(
        [
          "Connectors available in this chat:",
          "",
          ...available.map(
            (item) =>
              `${item.service}  ${item.name}  ${
                isConnected(item.service)
                  ? `connected${accountOf(item.service)}`
                  : "not connected — ask for it with this tool"
              }`
          ),
          ...chatApps.map(
            (item) =>
              `${item.service}  ${item.name}  ${
                item.live
                  ? "connected — send with its send_<platform>_message tool"
                  : "not connected — ask for it with this tool"
              }`
          ),
          "",
          "A connector listed as connected is one whose tools are already in your",
          "tool list — use those, do not guess a tool name. Where it says what it is",
          "connected as, that is the user's own account on that service: it is who",
          '"me" and "myself" mean, so do not ask them for it.',
        ].join("\n")
      );
    }

    // Case-, space- and punctuation-blind.
    const normalize = (text: string): string =>
      text.toLowerCase().replace(/[^a-z0-9]/g, "");
    const wanted = normalize(asked);

    const exact = available.filter(
      (item) =>
        normalize(item.service) === wanted || normalize(item.name) === wanted
    );
    // Near misses, only when nothing matched outright: ids carry suffixes
    // ("gmailuser") and people abbreviate.
    const loose =
      exact.length > 0
        ? exact
        : available.filter(
            (item) =>
              normalize(item.service).startsWith(wanted) ||
              normalize(item.name).startsWith(wanted) ||
              (wanted.length >= 4 &&
                (normalize(item.name).includes(wanted) ||
                  normalize(item.service).includes(wanted)))
          );

    if (loose.length > 1) {
      return this.ok(
        `"${asked}" matches more than one connector: ${loose
          .map((item) => `${item.name} (${item.service})`)
          .join(", ")}. Ask again with one of those.`
      );
    }

    const match = loose[0];

    if (match == null) {
      const chat = chatApp(asked);

      if (chat != null) {
        if (chat.live) {
          return this.ok(
            `${chat.name} is connected. Send, list and read with its own tools ` +
              "(send_<platform>_message, list_<platform>_chats, read_<platform>_messages) — do not ask the user to " +
              "connect anything."
          );
        }

        // The same Connect button every other connector gets, not a trip to
        // Settings.
        return this.ok(
          await connectors.request({
            service: chat.service,
            label: chat.name,
            conversationKey,
            ...(typeof args.reason === "string" && args.reason.length > 0
              ? { reason: args.reason }
              : {}),
          })
        );
      }

      return this.ok(
        `There is no connector called "${asked}".${
          available.length > 0
            ? ` Available: ${available
                .map((item) => `${item.name} (${item.service})`)
                .join(", ")}.`
            : ""
        }`
      );
    }

    if (isConnected(match.service)) {
      return this.ok(
        `${match.name} is already connected${accountOf(match.service)}. Use it — ` +
          "there is nothing to ask the user for, and that account is who they mean " +
          'by "me". Its tools are already in your tool list; use those rather than ' +
          "guessing a tool name."
      );
    }

    return this.ok(
      await connectors.request({
        service: match.service,
        label: match.name,
        conversationKey,
        ...(typeof args.reason === "string" && args.reason.trim().length > 0
          ? { reason: args.reason.trim() }
          : {}),
      })
    );
  }

  private async disconnectConnector(
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    const asked = String(args.service ?? "")
      .trim()
      .toLowerCase();
    if (asked.length === 0)
      return this.err(
        'A service is required, e.g. "googlecalendar" or "whatsapp".'
      );

    // The same lever as the card in Settings, so "off" means one thing.
    if (
      isMessagingPlatformId(asked) &&
      AGENT_LINKABLE_CHAT_APPS.includes(asked)
    ) {
      const disable = this.options.messaging?.disablePlatform;
      if (disable == null)
        return this.err("Messaging is not available in this session.");
      await disable(asked);
      return this.ok(
        `${CHAT_APP_LABELS[asked]} is disconnected — the platform is switched off. ` +
          "connect_connector switches it back on when the user wants it again."
      );
    }

    const connectors = this.options.connectors;
    if (connectors?.disconnect == null)
      return this.err("Connectors are not available in this session.");

    const { available, connected } = await connectors.list();
    const normalize = (text: string): string =>
      text.toLowerCase().replace(/[^a-z0-9]/g, "");
    const wanted = normalize(asked);
    const match =
      available.find((item) => normalize(item.service) === wanted) ??
      available.find((item) => normalize(item.name) === wanted) ??
      // A service can be attached even while a flaky catalog omits it.
      (connected.some((service) => normalize(service) === wanted)
        ? { service: asked, name: asked }
        : null);
    if (match == null)
      return this.err(
        `There is no connector called "${asked}". Ask connect_connector with no arguments for the list.`
      );
    if (!connected.includes(match.service))
      return this.ok(`${match.name} is not connected — nothing to disconnect.`);

    const error = await connectors.disconnect(match.service);
    if (error != null) return this.err(error);
    return this.ok(
      `${match.name} is disconnected. Its tools are gone from your tool list; ` +
        "connect_connector brings it back when the user wants it again."
    );
  }

  /**
   * What this bot has been doing in its other conversations, from the tail of
   * each owned agent log; the calling conversation is already in context.
   */
  private myActivity(callerSession?: string): ToolResult {
    const botId =
      callerSession != null
        ? (this.options.botIdForSession?.(callerSession) ?? null)
        : null;
    if (botId == null)
      return this.err("Only a bot's own chat can ask for its activity.");
    const chats = (this.options.ownActivity?.(botId) ?? []).filter(
      (chat) => chat.sessionId !== callerSession
    );
    if (chats.length === 0)
      return this.ok(
        "No other conversations yet — everything you have done is in this one."
      );

    const sections: string[] = [];
    for (const chat of chats.slice(0, 6)) {
      const turns = readTranscriptTail(chat.file, 8);
      if (turns.length === 0) continue;
      sections.push(
        [
          `## ${chat.label}`,
          ...turns.map((turn) => `${turn.role}: ${turn.text}`),
        ].join("\n")
      );
    }
    return this.ok(
      sections.length === 0
        ? "Your other conversations have no recorded turns yet."
        : sections.join("\n\n")
    );
  }

  private async listChats(args: Record<string, unknown>): Promise<ToolResult> {
    const messaging = this.options.messaging;
    if (messaging == null) return this.messagingSetupHint();

    const platforms = messaging.runningPlatforms();
    if (platforms.length === 0) return this.messagingSetupHint();

    // A platform still booting is waited for, not reported empty.
    await messaging.awaitReady?.();
    const starting = messaging.startingPlatforms?.() ?? [];
    const startingNote =
      starting.length > 0
        ? `\n\nStill starting: ${starting.join(", ")} — linked, and reading who the user is and the chat list. ` +
          "This finishes within a minute of launch. Try again in about twenty seconds; " +
          "do not tell the user nothing has synced or that they must message first."
        : "";

    const query = String(args.query ?? "").trim();
    const scopeArg = String(args.platform ?? "").trim();
    const scope = isMessagingPlatformId(scopeArg) ? scopeArg : undefined;
    if (args.only_unread === true && scope != null)
      return await this.listUnreadChats(scope);
    const listed =
      messaging.listChatsDetailed != null
        ? messaging.listChatsDetailed(
            query.length > 0 ? query : undefined,
            scope
          )
        : {
            rows: messaging.listChats(
              query.length > 0 ? query : undefined,
              scope
            ),
            hidden: {},
          };
    const rows = listed.rows;
    const hiddenEntries = Object.entries(listed.hidden).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && entry[1] > 0
    );
    const hiddenNote =
      hiddenEntries.length > 0
        ? "\n\nNot shown: " +
          hiddenEntries.map(([id, n]) => `${n} more on ${id}`).join(", ") +
          ' — pass a query, or platform: "<name>" to list one platform in full.'
        : "";
    const live = messaging.livePlatforms?.() ?? platforms;
    const down = platforms.filter((id) => !live.includes(id));
    // The header names what is actually up, not every started platform: the
    // model reads the header. The shared-bot lanes are spelled out so
    // "abacus_discord" is not read as the user's Discord.
    const connectedLine =
      live.length === 0
        ? "Connected platforms: none — nothing is linked right now."
        : `Connected platforms: ${live.map(describePlatformForAgent).join(", ")}`;
    // Added to every answer for a platform started but not connected: its
    // address book is empty, which must read as "not linked", not "no
    // contacts".
    const downNote =
      down.length > 0
        ? `\n\nNot connected right now: ${down.join(", ")} — reconnecting or waiting to be linked again. ` +
          "Anything missing here may simply be out of reach until it is back; say so rather than " +
          "asking the user to supply it."
        : "";
    const selves = messaging.selfChats?.() ?? [];
    const selfRows = selves.map(
      (row) => `${row.platform}  ${row.chatId}  (the user — "me")`
    );

    // Linked but unable to say who as. Say so, or the model asks the user for
    // the number of the phone they just paired.
    const pending = messaging.selfPending?.() ?? [];
    const selfless = live.filter(
      (id) =>
        !selves.some((row) => row.platform === id) && !pending.includes(id)
    );
    // Setup-in-progress has an ETA and a next step; tell the model both.
    const pendingLive = live.filter((id) => pending.includes(id));
    const pendingNote =
      pendingLive.length > 0
        ? `\n\n${pendingLive.join(", ")}: connected, but the assistant bot that ` +
          "delivers messages to the user is still being set up — this " +
          "usually finishes within a few minutes. If asked to message the " +
          "user there, say exactly that and offer to try again shortly."
        : "";
    const selfNote =
      selfless.length > 0
        ? `\n\nWho the user is on ${selfless.join(", ")} is not known yet. ` +
          "Do not ask them for their own number or handle — say you cannot " +
          "identify their own chat there yet, and offer to send to someone " +
          "named instead."
        : "";

    // An empty answer must say which kind of empty, or it reads as "your
    // query missed" and invites another search.
    if (rows.length === 0) {
      const known = query.length > 0 ? messaging.listChats().length : 0;

      if (known === 0 && starting.length > 0) {
        return this.ok(
          [
            connectedLine,
            "",
            ...(selfRows.length > 0 ? [...selfRows, ""] : []),
            "Nothing to list YET." + startingNote + downNote + pendingNote,
          ].join("\n")
        );
      }

      if (known === 0) {
        return this.ok(
          [
            connectedLine,
            "",
            ...(selfRows.length > 0 ? [...selfRows, ""] : []),
            "No chats yet — nobody has messaged in and no address book has synced, so " +
              "there is nothing to search. Another query will not find anything: the " +
              "user has to be messaged first, or message in. On WhatsApp you can still " +
              "send to a phone number." +
              downNote +
              pendingNote +
              selfNote,
          ].join("\n")
        );
      }

      return this.ok(
        [
          connectedLine,
          "",
          ...(selfRows.length > 0 ? [...selfRows, ""] : []),
          `No contact matching "${query}", out of ${known} known. This searched chat ` +
            "NAMES only. If the user means a topic, a place, a thing or words " +
            'someone said ("taco bell", "the invoice"), that is a MESSAGE search: use ' +
            "the platform's read tool with `query` — it searches message content " +
            "through the platform's own search. Omit the query here to see every " +
            "name. On WhatsApp you can still send to a phone number." +
            downNote +
            pendingNote +
            selfNote,
        ].join("\n")
      );
    }

    // Every row names its `to` outright: a WhatsApp group's name IS its id,
    // and unlabeled it reads as "no usable id".
    return this.ok(
      [
        connectedLine,
        "",
        ...(selfRows.length > 0 ? [...selfRows, ""] : []),
        rows
          .map((row) =>
            row.chatId === row.name
              ? `${row.platform}  to: "${row.chatId}"`
              : `${row.platform}  to: "${row.chatId}"  (${row.name})`
          )
          .join("\n"),
        "",
        "Each row's `to: \"...\"` is the exact value for the platform's send and " +
          "read tools — on WhatsApp a contact's or group's name IS its " +
          "chat id; there is no other id to look for." +
          hiddenNote,
        downNote + pendingNote + selfNote,
      ]
        .join("\n")
        .trimEnd()
    );
  }

  private async readChatMessages(
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    const messaging = this.options.messaging;
    if (messaging == null || messaging.runningPlatforms().length === 0)
      return this.messagingSetupHint();

    const platform = String(args.platform ?? "").trim();
    if (platform.length > 0 && !isMessagingPlatformId(platform))
      return this.err(`Unknown platform "${platform}".`);

    const chatId = String(args.chat_id ?? "").trim();
    const query = String(args.query ?? "").trim();
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    await messaging.awaitReady?.(
      isMessagingPlatformId(platform) ? platform : undefined
    );
    if (args.only_unread === true && isMessagingPlatformId(platform))
      return await this.readUnreadMessages(platform, limit);
    const rows = await messaging.readMessages({
      ...(isMessagingPlatformId(platform) ? { platform } : {}),
      ...(chatId.length > 0 ? { chatId } : {}),
      ...(query.length > 0 ? { query } : {}),
      ...(limit != null ? { limit } : {}),
    });

    if (rows.length === 0) {
      // History is stored, so this reads fine while a platform is down, but
      // "nothing here" then has two causes and must name the right one.
      if (isMessagingPlatformId(platform) && this.notLinked(platform) != null)
        return this.ok(
          `Nothing stored for that chat, and ${platform} is not connected right now — ` +
            "anything newer than the last sync is out of reach until it is back. " +
            "Say so rather than asking the user to name the chat differently."
        );

      if (query.length > 0)
        return this.ok(
          `No message containing "${query}" was found — the platform's own ` +
            "search came back empty too, so a different wording of the same " +
            "thing may still match. Try a shorter or more distinctive word."
        );

      return this.ok(
        "No messages in that chat, or none I can read right now. Try naming the exact person or chat."
      );
    }

    return this.ok(
      rows
        .map(
          (row) =>
            `[${row.at}] ${row.platform} ${row.chatId} ${
              row.direction === "out" ? "me" : (row.userName ?? row.userId)
            }: ${row.text}`
        )
        .join("\n")
    );
  }

  /** Live from the platform: the phone's badges, or "cannot say right now". */
  private async fetchUnread(
    platform: MessagingPlatformId
  ): Promise<UnreadFetch> {
    const messaging = this.options.messaging;
    if (messaging?.unreadChats == null)
      return {
        ok: false,
        result: this.ok(
          `${platform} cannot report unread counts. List the chats and read the ones the user names instead.`
        ),
      };
    if (this.notLinked(platform) != null)
      return {
        ok: false,
        result: this.ok(
          `${platform} is not connected right now, so what is unread there is out of reach until it is back. Say so.`
        ),
      };
    try {
      const rows = await messaging.unreadChats(platform);
      if (rows == null)
        return {
          ok: false,
          result: this.ok(
            `${platform} cannot report unread counts. List the chats and read the ones the user names instead.`
          ),
        };
      return { ok: true, rows };
    } catch (error) {
      return {
        ok: false,
        result: this.ok(
          `Could not read what is unread on ${platform}: ${
            error instanceof Error ? error.message : String(error)
          } Tell the user, and offer to read a chat they name.`
        ),
      };
    }
  }

  private async listUnreadChats(
    platform: MessagingPlatformId
  ): Promise<ToolResult> {
    const unread = await this.fetchUnread(platform);
    if (unread.ok === false) return unread.result;
    if (unread.rows.length === 0)
      return this.ok(
        `No ${platform} chats have unread messages right now — the user is caught up.`
      );
    return this.ok(
      [
        `${platform} chats with unread messages (${unread.rows.length}):`,
        "",
        ...unread.rows.map(
          (row) =>
            `${platform}  to: "${row.chatId}"  — ${describeUnread(row.unreadCount)}`
        ),
        "",
        "Read one with the platform's read tool and its `to:` value, or pass " +
          "`only_unread` there to read what is waiting in all of them.",
      ].join("\n")
    );
  }

  private async readUnreadMessages(
    platform: MessagingPlatformId,
    limit: number | undefined
  ): Promise<ToolResult> {
    const messaging = this.options.messaging;
    if (messaging == null) return this.messagingSetupHint();
    const unread = await this.fetchUnread(platform);
    if (unread.ok === false) return unread.result;
    if (unread.rows.length === 0)
      return this.ok(
        `No ${platform} chats have unread messages right now — the user is caught up.`
      );
    const chats = unread.rows.slice(0, UNREAD_CHATS_READ_CAP);
    const perChat = limit ?? UNREAD_PER_CHAT_DEFAULT;
    const sections: string[] = [];
    for (const chat of chats) {
      // A chat marked unread by hand has no count; show its newest few.
      const take = Math.min(
        perChat,
        chat.unreadCount > 0 ? chat.unreadCount : UNREAD_MARKED_PEEK
      );
      const rows = await messaging.readMessages({
        platform,
        chatId: chat.chatId,
        limit: take,
      });
      sections.push(
        [
          `— ${chat.name} (${describeUnread(chat.unreadCount)})`,
          ...(rows.length === 0
            ? ["  (nothing readable — the messages may be media only)"]
            : rows.map(
                (row) =>
                  `  [${row.at}] ${
                    row.direction === "out"
                      ? "me"
                      : (row.userName ?? row.userId)
                  }: ${row.text}`
              )),
        ].join("\n")
      );
    }
    const more =
      unread.rows.length > chats.length
        ? `\n\n${unread.rows.length - chats.length} more chat(s) have unread messages — list them with \`only_unread\` on the list tool and read them by name.`
        : "";
    return this.ok(sections.join("\n\n") + more);
  }

  /**
   * "Reply whenever X messages me" as one call. The user asking in the bot's
   * chat is the approval the pairing queue exists to collect.
   */
  private autoReply(
    args: Record<string, unknown>,
    callerSession?: string
  ): ToolResult {
    const messaging = this.options.messaging;
    const gateway = messaging?.autoReply;
    if (
      messaging == null ||
      gateway == null ||
      messaging.runningPlatforms().length === 0
    )
      return this.messagingSetupHint();

    const action = String(args.action ?? "");

    if (action === "status") {
      const status = gateway.status();
      const senders =
        status.approved.length === 0
          ? "No senders are allowed yet."
          : `Allowed senders: ${status.approved
              .map((row) => `${row.name} (${row.platform})`)
              .join(", ")}.`;

      return this.ok(
        status.respondToInbound
          ? `Auto-reply is on${status.botId != null ? ", delivered to a bot's chat" : ""}. ${senders}`
          : `Auto-reply is off. ${senders}`
      );
    }

    if (action === "off") {
      gateway.disable();

      return this.ok(
        "Auto-reply is off. Incoming messages are still logged for reading; nobody gets answered. Allowed senders are kept for next time."
      );
    }

    // BOTS_ONLY already guarantees a calling bot; this is the belt.
    const botId =
      callerSession != null
        ? (this.options.botIdForSession?.(callerSession) ?? null)
        : null;
    if (botId == null)
      return this.err("auto_reply only works in a bot's own chat.");

    if (
      action !== "on" &&
      action !== "allow_sender" &&
      action !== "remove_sender"
    )
      return this.err(`Unknown action "${action}".`);

    const sender = String(args.sender ?? "").trim();
    if (sender.length === 0 && action !== "on")
      return this.err('A "sender" is required.');

    let resolved: SenderCandidate | null = null;

    if (sender.length > 0) {
      const running = messaging.runningPlatforms();
      const platformArg = String(args.platform ?? "").trim();

      if (platformArg.length > 0 && !isMessagingPlatformId(platformArg))
        return this.err(`Unknown platform "${platformArg}".`);

      const platform = isMessagingPlatformId(platformArg)
        ? platformArg
        : running.length === 1
          ? running[0]
          : undefined;
      if (platform == null)
        return this.err(
          `Several platforms are connected (${running.join(", ")}) — say which one the sender is on.`
        );

      const resolution = resolveSender(
        gateway.senderCandidates(platform),
        sender
      );

      if (resolution.kind === "none") {
        // The name may not have messaged in yet; naming who has gives the
        // retry something to land on.
        const recent = gateway
          .status()
          .pending.filter((row) => row.platform === platform)
          .slice(-5)
          .map((row) => row.name);
        const hint =
          recent.length > 0
            ? ` Senders who have messaged recently and are not yet allowed: ${recent.join(", ")}.`
            : "";

        return this.err(
          `Nobody matching "${sender}" on ${platform}. Have that person send one message and retry the same name, or ask the user for the exact contact name.${hint}`
        );
      }
      if (resolution.kind === "ambiguous")
        return this.err(
          `"${sender}" matches several people on ${platform}: ${resolution.candidates
            .map((row) => row.name)
            .join(", ")}. Ask the user which one they mean.`
        );

      resolved = resolution.candidate;
    }

    if (action === "remove_sender") {
      gateway.removeSender(resolved!);

      return this.ok(`${resolved!.name} will no longer be answered.`);
    }

    if (resolved != null) gateway.allowSender(resolved, botId);
    if (action === "on") gateway.enable(botId);

    const allowedLine =
      resolved != null
        ? `${resolved.name} will be answered in a separate conversation of their own — everything written there is delivered to them, as the user. Gather the user's instructions for that sender now (tone, goals, what not to say) and store them in memory.`
        : "No sender allowed yet — allow one with allow_sender, or approve pending ones from the Connectors page.";

    return this.ok(
      action === "on" ? `Auto-reply is on. ${allowedLine}` : allowedLine
    );
  }

  // ── Integrations ─────────────────────────────────────────────────────────

  private async xSearch(args: Record<string, unknown>): Promise<ToolResult> {
    if (!xSearchReady()) return this.err(xSearchSetupHint);

    const query = String(args.query ?? "").trim();

    if (query.length === 0) return this.err("A query is required.");

    return this.ok(await xSearch(query));
  }

  private async homeAssistant(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    if (!homeAssistantReady()) return this.err(homeAssistantSetupHint);

    if (name === "ha_list_entities") {
      const filter = typeof args.filter === "string" ? args.filter : undefined;

      return this.ok(await haListEntities(filter));
    }

    if (name === "ha_get_state") {
      const entityId = String(args.entity_id ?? "").trim();

      if (entityId.length === 0) return this.err("An entity_id is required.");

      return this.ok(await haGetState(entityId));
    }

    if (name === "ha_list_services") {
      const domain = typeof args.domain === "string" ? args.domain : undefined;

      return this.ok(await haListServices(domain));
    }

    const domain = String(args.domain ?? "").trim();
    const service = String(args.service ?? "").trim();

    if (domain.length === 0 || service.length === 0)
      return this.err("Both domain and service are required.");

    const entityId =
      typeof args.entity_id === "string" ? args.entity_id : undefined;
    const data =
      args.data != null && typeof args.data === "object"
        ? (args.data as Record<string, unknown>)
        : undefined;

    return this.ok(await haCallService(domain, service, entityId, data));
  }

  // ── Result helpers ───────────────────────────────────────────────────────

  private ok(text: string): ToolResult {
    return { content: [{ type: "text", text }] };
  }

  private err(text: string): ToolResult {
    return { content: [{ type: "text", text }], isError: true };
  }
}
