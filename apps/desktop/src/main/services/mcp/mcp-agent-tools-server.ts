import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

/**
 * The agent-tools MCP server: skills, task planning, memory, the web, and
 * more. One server rather than one per toolset, since all are small and
 * in-process; each toolset toggles on its own, so `tools/list` filters by the
 * enabled set and a disabled toolset's tools are never advertised.
 */
import {
  APP_CHANNEL,
  type ChannelCapabilities,
  WHATSAPP_CHANNEL,
} from "@abacus-ai/agent/channel";
import { isWithin, resolveSecretPaths } from "@abacus-ai/agent/secret-paths";
import {
  DOCUMENT_MAX_BYTES,
  MEDIA_MAX_BYTES,
  mediaLine,
  parseSendMedia,
  type ResolvedMedia,
} from "@abacus-ai/agent/send-media";
import { UNATTENDED_TOOLS } from "@abacus-ai/agent/tool-policy";
import {
  CONNECTORS,
  resolveConnector,
  type Connector,
} from "@abacus-ai/connectors/registry";
import type {
  ConnectorStatus,
  ConnectorStatuses,
} from "@abacus-ai/contract/contracts";
import type { ConversationKey } from "@abacus-ai/contract/conversation-scope";
import { artifactPathLine } from "@abacus-ai/contract/deliverables";
import {
  isMessagingPlatformId,
  type MessagingPlatformId,
  describePlatformForAgent,
} from "@abacus-ai/contract/messaging";
import type {
  Routine,
  RoutineCreateInput,
  RoutineListItem,
  RoutineRunner,
} from "@abacus-ai/contract/routines";

import { emitHostEvent } from "#main/rpc/emit";

import { abacusBotHome, WORKSPACE_DIR_NAME } from "../../paths";
import {
  createJob,
  describeJob,
  listJobs,
  removeJob,
  updateJob,
  type RoutineRunStart,
} from "../agent-tools/cron-store";
import { exportDeckPdf } from "../agent-tools/deck-pdf";
import {
  HostedRoutineRefusal,
  isHostedRoutineId,
  type HostedRoutines,
} from "../agent-tools/hosted-routines";
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
import type { BotNumberOutcome } from "../messaging/bot-number";
import { MAX_ATTACHMENT_BYTES } from "../messaging/connector";
import {
  resolveSender,
  type SenderCandidate,
} from "../messaging/sender-resolution";
import { locateHostFile } from "../workspace/host-path";
import type { SkillsService } from "../workspace/skills-service";
import { McpHttpServer, type McpToolListing } from "./mcp-http-server";
import { agentTool, AGENT_TOOL_NAMES, AGENT_TOOLS } from "./tools";
import type {
  ConnectOutcome,
  DisconnectOutcome,
} from "./tools/connect-outcome";
import {
  describeHostedRoutine,
  hostedCreatedNote,
  hostedCreateInput,
  hostedRefusalNote,
  requestedReads,
  requestedRunner,
  requestedSources,
} from "./tools/cronjob-hosted";
import type { ToolDefinition, ToolResult } from "./tools/definition";
import {
  NOT_YET_PHONE_OWNED,
  PHONE_AGENT_TOOLS,
  phoneAgentTool,
} from "./tools/phone";
import type { PhoneToolDefinition } from "./tools/phone/definition";
import { readTranscriptTail } from "./transcript-tail";

const SERVER_NAME = "agent-tools";
const SERVER_VERSION = "1.0.0";

/** Chats an "everything unread" read opens before pointing at the list. */
const UNREAD_CHATS_READ_CAP = 10;
/** Messages per chat in an unread read when the caller gives no limit. */
const UNREAD_PER_CHAT_DEFAULT = 50;
/** For a chat marked unread by hand, which has no count to go by. */
const UNREAD_MARKED_PEEK = 5;
/** The server takes this much text in one WhatsApp message from AbacusAI Bot. */
const MAX_BOT_NUMBER_TEXT = 4_000;

type UnreadFetch =
  | {
      ok: true;
      rows: Array<{ chatId: string; name: string; unreadCount: number }>;
    }
  | { ok: false; result: ToolResult };

/** WhatsApp's counter in words: negative is "marked unread", not a number. */
const describeUnread = (count: number): string =>
  count < 0 ? "marked unread" : `${count} unread`;

type ChatMedia = NonNullable<
  ReturnType<NonNullable<McpAgentToolsServerOptions["chatMedia"]>>
>;

/** Text for a result line: one line, whatever it held. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The origin of a loopback http(s) URL; null for any other. */
const loopbackOrigin = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    return ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
};

/** Files that go to a chat as pictures. */
const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;

/** A tool as some caller sees it: the app's definition, or the phone's own. */
type ListedTool = ToolDefinition | PhoneToolDefinition;

const toolsetsFor = (definition: ListedTool): readonly string[] =>
  definition.toolsets === "always" ? [] : definition.toolsets;

const isToolEnabled = (definition: ListedTool, enabled: Set<string>): boolean =>
  definition.toolsets === "always" ||
  definition.toolsets.some((toolset) => enabled.has(toolset));

/**
 * A `file://` URL the chat's markdown renderer will linkify. pathToFileURL,
 * not interpolation: it escapes what the renderer decodes back and handles
 * Windows paths, where a raw `C:` parses as the URL's authority.
 */
const fileUrl = (absolutePath: string): string =>
  pathToFileURL(absolutePath).href;

export interface McpAgentToolsServerOptions {
  skillsService: SkillsService;
  /** Re-read per request so toggles take effect live. */
  enabledToolsets: () => Set<string>;
  workspacePath: () => string | null;
  workspaceId?: () => string | null;
  /** `trigger` lets the run log tell "Run now" from the first fire at creation. */
  runCronJob?: (
    jobId: string,
    trigger?: "manual" | "create"
  ) => Promise<RoutineRunStart>;
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
  /**
   * What the session's chat can do where a host lane says (the hosted
   * WhatsApp lane); null for every other session and bot, which are app
   * chats. Tool descriptions and results are rendered for it.
   */
  channelForSession?: (sessionId: string) => ChannelCapabilities | null;
  /**
   * True where a caller must name a live session (the hosted computer): one
   * with none, or with one `knownSession` does not know, is listed nothing
   * and refused, never served as an app chat.
   */
  requireSession?: () => boolean;
  knownSession?: (sessionId: string) => boolean;
  /**
   * Where `present_deliverable` puts what goes to a chat that takes media,
   * under the session's id; null where no chat does.
   */
  chatMedia?: () => {
    /** A file, as an image or a document, by its bytes and name. */
    keep: (
      sessionId: string,
      data: Buffer,
      filename: string
    ) => { id: string } | { reason: string };
    /** A screenshot of a page served at `origin`, with secret fields hidden. */
    screenshot: (
      url: string,
      origin: string,
      sessionId: string
    ) => Promise<{ id: string } | { reason: string }>;
  } | null;
  /** Set for the turn behind a routine page's composer; it sees only cron. */
  routineEditorFor?: (sessionId: string) => string | null;
  /** A run nobody is watching: it gets only the unattended allowlist. */
  isUnattended?: (sessionId: string) => boolean;
  /** What a bot-owned session is to its bot: its own chat, or one with someone else. */
  sessionRole?: (sessionId: string) => "forever" | "sender" | "routine" | null;
  /**
   * Routines beyond this computer's own: the one create path both runners
   * share, and the server's hosted routines. Absent, every routine is local.
   */
  routines?: {
    /** The runner a create that names none gets here. */
    defaultRunner: () => RoutineRunner;
    /** Every routine here runs on the server (the hosted bot): a local ask is made hosted. */
    hostedOnly?: () => boolean;
    /** ServiceHost.createRoutine: local or hosted by `input.runner`. */
    create: (
      input: RoutineCreateInput,
      options?: { byAgent?: boolean; runAtText?: string | null }
    ) => Promise<Routine>;
    hosted: HostedRoutines;
  };
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
  /**
   * The user's WhatsApp link to AbacusAI Bot's own number, on the hosted
   * computer; null elsewhere, where send_to_whatsapp is never listed.
   */
  botNumber?: () => {
    linked: () => boolean;
    notify: (
      text: string,
      media: Extract<ResolvedMedia, { ok: true }> | null
    ) => Promise<BotNumberOutcome>;
    /** A media id, as bytes, for the session that holds it. */
    resolveMedia: (ref: string, sessionId: string) => ResolvedMedia;
  } | null;
  /** Optional: headless has no account, and the tool reports unconfigured. */
  connectors?: {
    /** Every registry connector's status on this machine, by connector id. */
    list: () => Promise<ConnectorStatuses>;
    /**
     * A one-tap link for a platform connector, and every connector it attaches
     * (one Google consent covers Gmail, Drive and Calendar, less the members
     * already connected, which `connectedIds` names), or the web host's
     * connect route for an MCP server. `requestId` lets the watch read the
     * link's own outcome. `sessionId` is the asking chat, which the link's
     * completion reports back to. Null signed out, or with no link to give.
     */
    link: (
      connectorId: string,
      sessionId: string | null
    ) => Promise<{
      url: string;
      connectorIds: string[];
      connectedIds?: string[];
      requestId?: string;
    } | null>;
    /** A Connect card in the conversation that asked; nothing waits on it. */
    show: (input: {
      connectorId: string;
      label: string;
      reason?: string;
      conversationKey: ConversationKey;
    }) => void;
    /** Follow these until they connect: tools refresh, cards clear, the asking chat is told. */
    watch: (input: {
      connectorIds: string[];
      sessionId: string | null;
      requestId?: string;
      /** A reconnect: judged by the link's completion alone. */
      byLinkOnly?: boolean;
    }) => void;
    /** Resolves to null or an error sentence. */
    disconnect?: (connectorId: string) => Promise<string | null>;
  };
}

/**
 * Not read from the platform catalog: that carries i18n keys and the main
 * process has no translator.
 */
export class McpAgentToolsServer extends McpHttpServer {
  constructor(private readonly options: McpAgentToolsServerOptions) {
    // listChanged: a platform's tools appear the moment it connects, and
    // service-host calls notifyToolListChanged when they do.
    super({ name: SERVER_NAME, version: SERVER_VERSION, listChanged: true });
  }

  /** The loopback origins `serve` returned to each session. */
  private readonly servedOrigins = new Map<string, Set<string>>();

  /** The always-on tools guarantee this. */
  hasEnabledTools(): boolean {
    const enabled = this.options.enabledToolsets();

    return AGENT_TOOLS.some((definition) => isToolEnabled(definition, enabled));
  }

  protected listTools(callerSession?: string): McpToolListing[] {
    const enabled = this.options.enabledToolsets();
    const forBot = this.isBotCaller(callerSession);
    const forEditor = this.isRoutineEditor(callerSession);
    const channel = this.channelFor(callerSession);
    // A run nobody is watching is offered only what it may call.
    const held = this.isHeld(callerSession);

    return this.toolsFor(callerSession)
      .filter((definition) =>
        held && !Object.hasOwn(UNATTENDED_TOOLS, definition.name)
          ? false
          : forEditor
            ? definition.name === "cronjob"
            : this.isListedTool(definition, enabled, forBot)
      )
      .map((definition) => ({
        name: definition.name,
        description:
          typeof definition.description === "string"
            ? definition.description
            : definition.description(channel),
        inputSchema:
          typeof definition.inputSchema === "function"
            ? definition.inputSchema(channel)
            : definition.inputSchema,
      }));
  }

  /**
   * The phone lane's session: it is served only phone definitions
   * (tools/phone), never an app tool's words.
   */
  private isPhoneCaller(callerSession?: string): boolean {
    return this.channelFor(callerSession) === WHATSAPP_CHANNEL;
  }

  /** On the hosted computer, a caller that names no live session gets nothing. */
  private refusesCaller(callerSession?: string): boolean {
    if (this.options.requireSession?.() !== true) return false;
    return (
      callerSession == null ||
      this.options.knownSession?.(callerSession) !== true
    );
  }

  /** The definition `name` has for this caller, or none: a phone caller never falls back to the app's. */
  private toolFor(
    name: string,
    callerSession?: string
  ): ListedTool | undefined {
    if (this.refusesCaller(callerSession)) return undefined;
    if (!this.isPhoneCaller(callerSession)) return agentTool(name);
    return (
      phoneAgentTool(name) ??
      (NOT_YET_PHONE_OWNED.includes(name) ? agentTool(name) : undefined)
    );
  }

  /** Every definition this caller may be listed, in the app's order. */
  private toolsFor(callerSession?: string): ListedTool[] {
    if (this.refusesCaller(callerSession)) return [];
    if (!this.isPhoneCaller(callerSession)) return [...AGENT_TOOLS];
    const names = [
      ...AGENT_TOOL_NAMES,
      ...PHONE_AGENT_TOOLS.map((definition) => definition.name).filter(
        (name) => !AGENT_TOOL_NAMES.includes(name)
      ),
    ];
    return names
      .map((name) => this.toolFor(name, callerSession))
      .filter((definition) => definition != null);
  }

  /**
   * What the caller's chat can do: its lane's channel (the hosted phone),
   * else an app chat's, which is what every other session and bot sees.
   */
  channelFor(callerSession?: string): ChannelCapabilities {
    if (callerSession == null) return APP_CHANNEL;
    return this.options.channelForSession?.(callerSession) ?? APP_CHANNEL;
  }

  /** A run nobody is watching, held to the unattended allowlist. */
  private isHeld(callerSession?: string): boolean {
    return (
      callerSession != null &&
      this.options.isUnattended?.(callerSession) === true
    );
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

  /**
   * `tools/call`, gated the same way `tools/list` is (re-checked here), so a
   * toolset switched off mid-session stops working even while the model
   * holds an older tool list. Public for the tests that call tools directly.
   */
  async executeTool(
    name: string,
    args: Record<string, unknown>,
    callerSession?: string
  ): Promise<ToolResult> {
    if (this.refusesCaller(callerSession))
      return this.err("This call names no session here, so no tool runs.");
    const definition = this.toolFor(name, callerSession);

    if (definition == null) return this.err(`Unknown tool: ${name}`);

    // The agent's gate refuses these first; this holds even if it did not.
    if (this.isHeld(callerSession) && !Object.hasOwn(UNATTENDED_TOOLS, name))
      return this.err(
        `${name} is not available in a routine that runs on its own.`
      );

    const forEditor = this.isRoutineEditor(callerSession);
    if (forEditor && name !== "cronjob")
      return this.err("This session can only change its routine.");
    if (
      !forEditor &&
      !isToolEnabled(definition, this.options.enabledToolsets()) &&
      !(
        "botAlways" in definition &&
        definition.botAlways === true &&
        this.isBotCaller(callerSession)
      )
    ) {
      return this.err(
        `The ${toolsetsFor(definition).join("/")} toolset is switched off in Capabilities.`
      );
    }

    if (
      "botsOnly" in definition &&
      definition.botsOnly === true &&
      !this.isBotCaller(callerSession)
    ) {
      return this.err(
        `${name} is only available in a bot's chat. Carry on and use your best judgement.`
      );
    }

    try {
      return await definition.run(this, args, callerSession);
    } catch (error) {
      return this.err(error instanceof Error ? error.message : String(error));
    }
  }

  // ── Skills ───────────────────────────────────────────────────────────────

  async skillsList(): Promise<ToolResult> {
    const workspacePath = this.options.workspacePath();
    const { skills } = await this.options.skillsService.listInstalled(
      workspacePath != null ? { workspacePath } : {}
    );

    if (skills.length === 0) return this.ok("No skills are installed.");

    return this.ok(
      skills
        .map(
          (skill) =>
            `${skill.id} [${skill.source}]: ${skill.description ?? "no description"}`
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

  async skillView(id: string): Promise<ToolResult> {
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

  async skillManage(id: string): Promise<ToolResult> {
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

  todo(args: Record<string, unknown>): ToolResult {
    const action = String(args.action ?? "");

    if (action === "list") return this.ok(renderTodos(readTodos()));

    if (action !== "set") return this.err('action must be "set" or "list".');

    const result = setTodos(args.todos);

    return result.ok
      ? this.ok(`${result.message}\n\n${renderTodos(result.items)}`)
      : this.err(result.message);
  }

  // ── Memory ───────────────────────────────────────────────────────────────

  async memory(args: Record<string, unknown>): Promise<ToolResult> {
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
  private async fireOnCreate(jobId: string): Promise<RoutineRunStart> {
    try {
      return (await this.options.runCronJob?.(jobId, "create")) ?? "started";
    } catch {
      return "failed";
    }
  }

  async cronjob(
    args: Record<string, unknown>,
    callerSession?: string
  ): Promise<ToolResult> {
    const action = String(args.action ?? "");
    const id = typeof args.id === "string" ? args.id.trim() : "";

    // A routine runs as the user: a chat with someone else neither sees nor
    // touches any, before any runner is chosen (a hosted-only host's too).
    if (this.isSenderChat(callerSession))
      return this.err(
        "Routines are set up by the user, not from a chat with someone else."
      );

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
            ? `\n\n(${others} other routine${others === 1 ? "" : "s"} belong to the user or other bots, not yours to run.)`
            : "";

        const none =
          callerBot == null ? "No routines yet." : "No routines of yours yet.";
        // Hosted routines are the account's, listed beside this computer's;
        // a bot sees its own, and a chat with someone else sees none.
        const hosted = this.visibleHosted(callerSession).map(
          describeHostedRoutine
        );
        const local = visible
          .filter((job) => job.serverId == null)
          .map(describeJob);

        return this.ok(
          local.length + hosted.length === 0
            ? `${none}${suffix}`
            : [...local, ...hosted].join("\n\n") + suffix
        );
      }

      if (action === "create") {
        const runner =
          requestedRunner(args) ??
          this.options.routines?.defaultRunner() ??
          "local";
        // On a hosted-only bot a "local" ask is made hosted too, through the
        // same input (time zone, kind, reminder text), never a bare local one.
        if (
          (runner === "hosted" ||
            this.options.routines?.hostedOnly?.() === true) &&
          this.options.routines != null
        )
          return await this.createHostedRoutine(args, callerSession);

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

        const input = {
          schedule: schedule.trim().length > 0 ? schedule : null,
          webhook,
          prompt,
          name: typeof args.name === "string" ? args.name : undefined,
          workspaceId: this.options.workspaceId?.() ?? null,
          botId,
        };
        // What it may read, as asked: held until the user allows it.
        const sources = requestedSources(args);
        const reads = requestedReads(args);
        // The one create path, local here; without a host, the store itself.
        const job =
          this.options.routines != null
            ? await this.options.routines.create(
                { ...input, runner: "local", sources, reads },
                { byAgent: true }
              )
            : createJob(input);
        this.options.onCronChanged?.();

        // Every routine runs once the moment it is set up: waiting for the
        // first tick leaves no way to tell one that works from one that
        // quietly does not. Unless the caller has just done that pass itself.
        const fire =
          job.enabled &&
          job.schedule != null &&
          args.firstRun !== false &&
          this.options.runCronJob != null
            ? await this.fireOnCreate(job.id)
            : null;
        const firedNow = fire === "started";

        const delivery =
          "It lives under Routines in the sidebar; each fire runs in a fresh session of its own, listed there with its outcome." +
          (botId != null
            ? " It speaks in your voice and counts as one of yours."
            : "");
        // The double-send guard: the fire is the demonstration, and the
        // creating agent must not also perform the task "to confirm it works".
        // The fire is the demonstration and the double-send guard, but only a
        // fire that started: told "it is running now" about a run that was
        // skipped, the model confirmed the setup and the task was never done.
        const first = firedNow
          ? " The first one is running now, without waiting for the next tick: " +
            "it performs the routine's task itself, so do NOT also do that " +
            "task (send the message, gather the summary) here: that would " +
            "reach the user twice. Just confirm the setup in a sentence."
          : fire != null
            ? " Its first run could not start right now (see the Routines " +
              "panel for why), so nothing has been done yet: do this pass " +
              "yourself here if the user is waiting on it, and the routine " +
              "takes over from its next tick."
            : "";
        const hook =
          job.webhookToken != null
            ? `\nIt can also be fired by POST to the webhook shown in the Routines panel.`
            : "";

        // Its runs are unattended: say what that means, and that what it was
        // asked to read waits for the user.
        const reach =
          " Its runs are unattended: they search the web and read its own folder, but " +
          "cannot write files, run commands or message anyone, unless the user gives it " +
          "full access on its page." +
          (sources.length + reads.length > 0
            ? " It reads nothing you asked for (" +
              [...reads, ...sources].join(", ") +
              ") until the user allows it on the routine's page: tell them."
            : "");
        return this.ok(
          `Created. ${delivery}${reach}${first}${hook}\n\n${describeJob(job)}`
        );
      }

      if (id.length === 0)
        return this.err(
          `"${action}" needs an id. Use action "list" to see them.`
        );

      if (isHostedRoutineId(id) && this.options.routines != null) {
        // Only what this caller may see may be touched: a bot its own, a
        // chat with someone else nothing.
        if (
          !this.visibleHosted(callerSession).some(
            (routine) => routine.id === id
          )
        )
          return this.err(
            `Routine ${id} is not yours to ${action}, or does not exist.`
          );
        return await this.hostedRoutineAction(
          action,
          id,
          args,
          this.callerBot(callerSession)
        );
      }

      // A bot may change or fire only its own routines: `list` hides the
      // rest, but an id read off the Routines panel or an earlier turn must
      // not reach them either.
      const callerBot =
        callerSession != null
          ? (this.options.botIdForSession?.(callerSession) ?? null)
          : null;
      if (callerBot != null) {
        const job = listJobs().find((entry) => entry.id === id);
        if (job == null) return this.err(`No job with id "${id}".`);
        if (job.botId !== callerBot)
          return this.err(
            `Routine ${id} is not yours to ${action}; it belongs to the user or another bot.`
          );
      }

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
            "Nothing to update: give a schedule, a prompt, a name, or enabled."
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
            ? `Started ${id} now in a fresh run, listed under Routines and written in your voice.`
            : `Started ${id} now in a fresh run, listed under Routines.`
        );
      }

      return this.err(`Unknown action "${action}".`);
    } catch (error) {
      if (error instanceof HostedRoutineRefusal)
        return this.ok(hostedRefusalNote(error, action));
      return this.err(error instanceof Error ? error.message : String(error));
    }
  }

  /** The bot behind a session, or null for the user's own. */
  private callerBot(callerSession?: string): string | null {
    return callerSession != null
      ? (this.options.botIdForSession?.(callerSession) ?? null)
      : null;
  }

  /** A bot's chat with someone other than the user: never near the user's routines. */
  private isSenderChat(callerSession?: string): boolean {
    return (
      callerSession != null &&
      this.options.sessionRole?.(callerSession) === "sender"
    );
  }

  /** The hosted routines a caller may see: a bot its own, the user all. */
  private visibleHosted(callerSession?: string): RoutineListItem[] {
    if (this.isSenderChat(callerSession)) return [];
    const bot = this.callerBot(callerSession);
    const all = this.options.routines?.hosted.list() ?? [];
    return bot == null ? all : all.filter((routine) => routine.botId === bot);
  }

  /** A hosted create: the server's answer, or its refusal, said to the model. */
  private async createHostedRoutine(
    args: Record<string, unknown>,
    callerSession?: string
  ): Promise<ToolResult> {
    // A routine runs as the user; nobody else's chat may set one up.
    if (this.isSenderChat(callerSession))
      return this.err(
        "Routines that run on their own are set up by the user, not from a chat with someone else."
      );
    // A bot's own chat makes the bot's routine, and only that.
    const botId = this.callerBot(callerSession);
    const { input, runAtText } = hostedCreateInput(args, botId);
    if (
      (input.prompt ?? "").trim().length === 0 ||
      ((input.schedule ?? "").length === 0 &&
        runAtText == null &&
        input.webhook !== true)
    )
      return this.err(
        "A prompt (or reminder_text), and a schedule, run_at or webhook: true, are required."
      );
    try {
      const routine = await this.options.routines!.create(input, {
        byAgent: true,
        runAtText,
      });
      this.options.onCronChanged?.();
      const row = this.options.routines!.hosted.find(routine.id);
      return this.ok(
        row != null
          ? hostedCreatedNote(row, !this.channelFor(callerSession).pane)
          : `Created ${routine.id}.`
      );
    } catch (error) {
      if (error instanceof HostedRoutineRefusal)
        return this.ok(hostedRefusalNote(error));
      throw error;
    }
  }

  /** pause, resume, remove, update or run on a hosted routine, by its id. */
  private async hostedRoutineAction(
    action: string,
    id: string,
    args: Record<string, unknown>,
    /** The calling bot: the server refuses it another bot's routine too. */
    botId: string | null
  ): Promise<ToolResult> {
    const hosted = this.options.routines!.hosted;
    try {
      if (action === "remove") {
        await hosted.remove(id, botId);
        this.options.onCronChanged?.();
        return this.ok(`Removed ${id}.`);
      }
      if (action === "pause" || action === "resume") {
        const routine = await hosted.setEnabled(id, action === "resume", botId);
        this.options.onCronChanged?.();
        return this.ok(
          routine != null ? describeHostedRoutine(routine) : `${action}d ${id}.`
        );
      }
      if (action === "run") {
        await hosted.runNow(id, botId);
        return this.ok(
          `Started ${id} on the server; its result goes to the user the usual way, not here.`
        );
      }
      if (action === "update") {
        // The user's words for a moment go as written.
        const runAt =
          typeof args.run_at === "string" && args.run_at.trim().length > 0
            ? args.run_at.trim()
            : null;
        const sources = requestedSources(args);
        const reads = requestedReads(args);
        const changes = {
          ...(typeof args.name === "string" && args.name.trim().length > 0
            ? { name: args.name.trim() }
            : {}),
          ...(typeof args.prompt === "string" && args.prompt.trim().length > 0
            ? { prompt: args.prompt.trim() }
            : {}),
          ...(typeof args.schedule === "string" &&
          args.schedule.trim().length > 0
            ? { cron: args.schedule.trim() }
            : {}),
          ...(runAt != null ? { at: runAt } : {}),
          ...(sources.length > 0 ? { sources } : {}),
          ...(reads.length > 0 ? { reads } : {}),
          ...(typeof args.watch_url === "string" &&
          args.watch_url.trim().length > 0
            ? { watchUrl: args.watch_url.trim() }
            : {}),
          ...(typeof args.timezone === "string" &&
          args.timezone.trim().length > 0
            ? { timezone: args.timezone.trim() }
            : {}),
        };
        const enabled =
          typeof args.enabled === "boolean" ? args.enabled : undefined;
        if (Object.keys(changes).length === 0 && enabled == null)
          return this.err(
            "Nothing to update: give a schedule, run_at, timezone, a prompt, a name, or enabled."
          );
        let routine =
          Object.keys(changes).length > 0
            ? await hosted.update(id, changes, botId)
            : null;
        if (enabled != null)
          routine = await hosted.setEnabled(id, enabled, botId);
        this.options.onCronChanged?.();
        return this.ok(
          routine != null ? describeHostedRoutine(routine) : `Updated ${id}.`
        );
      }
      return this.err(`Unknown action "${action}".`);
    } catch (error) {
      if (error instanceof HostedRoutineRefusal)
        return this.ok(hostedRefusalNote(error, action));
      throw error;
    }
  }

  // ── Vision and video analysis ────────────────────────────────────────────

  async analyze(
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

  async imageGenerate(args: Record<string, unknown>): Promise<ToolResult> {
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

  async textToSpeech(args: Record<string, unknown>): Promise<ToolResult> {
    const text = String(args.text ?? "").trim();

    if (text.length === 0) return this.err("There is no text to speak.");

    const voice = typeof args.voice === "string" ? args.voice : undefined;
    const file = await generateSpeech(text, voice);

    return this.ok(`Saved to ${file}\n${artifactPathLine(file)}`);
  }

  async pdf(args: Record<string, unknown>): Promise<ToolResult> {
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
            `Printed ${printed.htmlPath} (${printed.pages} pages in ${printed.seconds}s): ${printed.pdfPath}`,
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
    emitHostEvent({
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
  async serve(
    args: Record<string, unknown>,
    callerSession?: string
  ): Promise<ToolResult> {
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
        const before = listServed();
        const stopped = stopDirectory(this.resolveOutputPath(directory));
        // Its port is free again: no session may screenshot whatever takes it.
        const still = new Set(listServed().map((entry) => entry.url));
        for (const entry of before) {
          const origin = loopbackOrigin(entry.url);
          if (still.has(entry.url) || origin == null) continue;
          for (const origins of this.servedOrigins.values())
            origins.delete(origin);
        }
        return this.ok(
          stopped ? "Stopped." : "That directory was not being served."
        );
      }

      if (action === "start") {
        const served = await serveDirectory(this.resolveOutputPath(directory));
        if (callerSession != null) {
          const origin = loopbackOrigin(served.url);
          if (origin != null)
            this.servedOrigins.set(
              callerSession,
              (this.servedOrigins.get(callerSession) ?? new Set()).add(origin)
            );
        }
        // The page, not the folder, unless the folder has an index; a root
        // URL for a folder holding only `love.html` opens onto "Not found".
        const pages = await htmlPagesIn(served.directory);
        const entry =
          pages[0] === "index.html" || pages.length === 0
            ? served.url
            : pages.length === 1
              ? `${served.url}/${encodeURIComponent(pages[0]!)}`
              : null;

        const channel = this.channelFor(callerSession);
        return this.ok(
          [
            `Serving ${served.directory} at ${served.url}`,
            "",
            ...(channel.pane
              ? []
              : [
                  "This URL opens on this computer only: the user cannot open it from their phone." +
                    (channel.media
                      ? " present_deliverable sends them a screenshot of the page instead."
                      : ""),
                  "",
                ]),
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

  async presentDeliverable(
    args: Record<string, unknown>,
    callerSession?: string
  ): Promise<ToolResult> {
    const rawItems = Array.isArray(args.items) ? args.items : [];

    if (rawItems.length === 0)
      return this.err(
        "At least one item is required, each with a path or an http(s) URL."
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
      // A URL cannot be stat'ed; a path is located on disk, by how its name
      // reads if need be, so the item carries the file's real name and a bad
      // path never reports as shown.
      const target = isUrl
        ? raw
        : await locateHostFile(this.resolveOutputPath(raw));
      if (target == null) {
        missing.push(this.resolveOutputPath(raw));
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
        `Nothing could be presented: none of those exist. Check the paths.${detail}`
      );
    }

    const channel = this.channelFor(callerSession);
    const chatMedia = this.options.chatMedia?.() ?? null;
    if (
      (channel.media || channel.documents) &&
      chatMedia != null &&
      callerSession != null
    )
      return this.sendToChat(valid, missing, args, chatMedia, callerSession);

    const first = valid[0]!;
    // Only the first item goes to the preview pane; the rest are rows of the
    // files card. A bot's turn opens nothing: a document jumping open over
    // the user's unrelated work reads as the app misbehaving.
    const forBot = this.isBotCaller(callerSession);
    const toPane = !forBot && channel.pane;
    if (toPane) this.broadcastPreviewOpen(first.target, callerSession);

    const summary = String(args.summary ?? "").trim();
    const lines = [
      ...(summary.length > 0 ? [summary, ""] : []),
      ...valid.map(
        (item) =>
          `- [${item.label}](${item.isUrl ? item.target : fileUrl(item.target)})`
      ),
      "",
      toPane
        ? `Listed in the chat as a files card; ${first.label} was sent to the preview pane.`
        : "Listed in the chat as a files card the user can open.",
    ];

    if (missing.length > 0) {
      lines.push(
        "",
        `Not presented, because there is no file at these paths: ${missing.join(", ")}`
      );
    }
    // The files card and the artifacts ledger read these, not the arguments.
    lines.push("", ...valid.map((item) => artifactPathLine(item.target)));

    return this.ok(lines.join("\n"));
  }

  /**
   * `present_deliverable` for a chat that takes media (WhatsApp): each item
   * is kept as the session's media and declared with a media line, which the
   * chat's lane sends with the turn's answer. A served URL goes as a
   * screenshot, since the user cannot open it. The result says what goes and
   * what cannot, never a pane.
   */
  private async sendToChat(
    valid: Array<{ label: string; target: string; isUrl: boolean }>,
    missing: string[],
    args: Record<string, unknown>,
    chatMedia: ChatMedia,
    sessionId: string
  ): Promise<ToolResult> {
    const going: Array<{ line: string; id: string; target: string }> = [];
    const refused: string[] = [];
    for (const item of valid) {
      const label = oneLine(item.label);
      const kept = item.isUrl
        ? await this.screenshotServed(item.target, sessionId, chatMedia)
        : await this.keepFile(item.target, sessionId, chatMedia);
      if ("reason" in kept) {
        refused.push(`${label}: ${oneLine(kept.reason)}`);
        continue;
      }
      going.push({
        id: kept.id,
        target: item.target,
        line: item.isUrl
          ? `- ${label}: a screenshot of the page (a live preview cannot be opened from the phone)`
          : `- ${label}`,
      });
    }

    const notFound =
      missing.length > 0
        ? [
            oneLine(
              `Not sent, because there is no file at these paths: ${missing.join(", ")}`
            ),
          ]
        : [];
    if (going.length === 0)
      return this.err(
        ["Nothing was sent to the chat.", ...refused, ...notFound].join("\n")
      );

    // One line each: a newline could pose as a media line.
    const summary = oneLine(String(args.summary ?? ""));
    const lines = [
      ...(summary.length > 0 ? [summary, ""] : []),
      `Sending ${going.length === 1 ? "1 item" : `${going.length} items`} to this chat with your answer:`,
      ...going.map((item) => item.line),
      "",
      "The first text of your answer goes with the first item as its caption. Do not paste paths or links to them.",
      ...(refused.length > 0
        ? ["", "Not sent:", ...refused.map((line) => `- ${line}`)]
        : []),
      ...(notFound.length > 0 ? ["", ...notFound] : []),
      "",
      ...going.map((item) => mediaLine(item.id)),
      ...going.map((item) => artifactPathLine(oneLine(item.target))),
    ];
    return this.ok(lines.join("\n"));
  }

  /**
   * A screenshot of a page this session served: only a loopback URL whose
   * origin `serve` returned to it, never any other address.
   */
  private async screenshotServed(
    url: string,
    sessionId: string,
    chatMedia: ChatMedia
  ): Promise<{ id: string } | { reason: string }> {
    const origin = loopbackOrigin(url);
    if (
      origin == null ||
      this.servedOrigins.get(sessionId)?.has(origin) !== true
    )
      return {
        reason:
          "only a page you served with `serve` in this chat can be sent, as a screenshot.",
      };
    return chatMedia.screenshot(url, origin, sessionId);
  }

  /**
   * A file on disk, kept as the session's media, or why it cannot go. Only a
   * regular file whose real path is under the workspace or the app's own
   * output and temp folders, outside every credential store; read no further
   * than the most the chat takes.
   */
  private async keepFile(
    filePath: string,
    sessionId: string,
    chatMedia: ChatMedia
  ): Promise<{ id: string } | { reason: string }> {
    let handle: fs.promises.FileHandle | null = null;
    try {
      const real = await fs.promises.realpath(filePath);
      const workspace = this.options.workspacePath();
      const roots = await Promise.all(
        [
          ...(workspace != null ? [workspace] : []),
          path.join(abacusBotHome(), "temp"),
          path.join(abacusBotHome(), "generated"),
        ].map((root) => fs.promises.realpath(root).catch(() => null))
      );
      if (!roots.some((root) => root != null && isWithin(real, root)))
        return {
          reason:
            "only files in the workspace (or ones a tool just made) can be sent; copy it into the workspace first.",
        };
      const denied = resolveSecretPaths({
        workspaceRoot: workspace ?? real,
      }).denied;
      if (denied.some((secret) => isWithin(real, secret)))
        return { reason: "it is in a credential store and is never sent." };
      // Checked before opening too: opening a pipe would wait for a writer.
      const checked = await fs.promises.stat(real);
      if (!checked.isFile()) return { reason: "it is not a regular file." };
      handle = await fs.promises.open(
        real,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
      );
      const stat = await handle.stat();
      // The file opened must be the one checked, not one swapped in since.
      if (stat.dev !== checked.dev || stat.ino !== checked.ino)
        return { reason: "it changed while being read; send it again." };
      if (!stat.isFile()) return { reason: "it is not a regular file." };
      if (IMAGE_FILE.test(real) && stat.size > MEDIA_MAX_BYTES)
        return {
          reason:
            "it is an image larger than 5 MB, the most a picture may be; save a smaller copy (or a PDF) and send that.",
        };
      // Read no further than the limit, whatever the size said.
      const buffer = Buffer.alloc(DOCUMENT_MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          length
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > DOCUMENT_MAX_BYTES)
        return { reason: "it is larger than 16 MB, the most the chat takes." };
      return chatMedia.keep(
        sessionId,
        Buffer.from(buffer.subarray(0, length)),
        path.basename(real)
      );
    } catch (error) {
      console.error(
        `[agent-tools] could not read a deliverable: ${error instanceof Error ? error.message : String(error)}`
      );
      return { reason: "it could not be read." };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async deckExportPdf(args: Record<string, unknown>): Promise<ToolResult> {
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
          "Read the PDF back and look at it before showing the user. Overflowing text is obvious in the render and invisible in the markup."
      );
    } catch (error) {
      return this.err(
        `Could not export the deck: ${(error as Error)?.message ?? "unknown error"}`
      );
    }
  }

  async submitVideoJob(args: Record<string, unknown>): Promise<ToolResult> {
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
      `Submitted as job ${jobId}. Generation takes minutes: check it with bfl_flux3_get_result, polling every 20-30 seconds rather than continuously.`
    );
  }

  async pollVideoJob(args: Record<string, unknown>): Promise<ToolResult> {
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

  /**
   * See ToolDefinition.ready. An instance method because messaging readiness
   * lives on the gateway.
   */
  private isToolConfigured(definition: ListedTool): boolean {
    if ("surface" in definition) return definition.ready?.() ?? true;
    if (definition.hidden === true) {
      return (this.options.messaging?.runningPlatforms().length ?? 0) > 0;
    }
    if (definition.botNumber === true)
      return this.options.botNumber?.()?.linked() === true;
    // No Discord tools on a machine that never connected Discord.
    if (definition.platform != null)
      return (
        this.options.messaging
          ?.runningPlatforms()
          .includes(definition.platform) ?? false
      );
    return definition.ready?.() ?? true;
  }

  /** Whether `tools/list` shows an app tool to an app caller. */
  isListed(name: string, enabled: Set<string>, forBot: boolean): boolean {
    const definition = agentTool(name);
    return definition != null && this.isListedTool(definition, enabled, forBot);
  }

  private isListedTool(
    definition: ListedTool,
    enabled: Set<string>,
    forBot: boolean
  ): boolean {
    if ("surface" in definition)
      return (
        isToolEnabled(definition, enabled) && this.isToolConfigured(definition)
      );
    if (definition.hidden === true) return false;
    return (
      (isToolEnabled(definition, enabled) ||
        (forBot && definition.botAlways === true)) &&
      this.isToolConfigured(definition) &&
      (forBot || definition.botsOnly !== true)
    );
  }

  /** For tests and diagnostics. */
  listedToolNames(forBot = false): string[] {
    const enabled = this.options.enabledToolsets();
    return AGENT_TOOLS.map((definition) => definition.name).filter((name) =>
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
        "send the user to Settings, and do not ask them for the number: " +
        `call connect_connector with service "${platform}": it puts a ` +
        "Connect card in front of the user right here, without waiting."
    );
  }

  async sendChatMessage(args: Record<string, unknown>): Promise<ToolResult> {
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
          `That file is ${Math.round(size / 1024 / 1024)}MB; the limit is ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB.`
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
   * `send_to_whatsapp`: the server sends it through its gate, or says why
   * not, and the result is that answer: never "sent" for what did not go.
   */
  async sendToWhatsApp(
    args: Record<string, unknown>,
    callerSession?: string
  ): Promise<ToolResult> {
    const botNumber = this.options.botNumber?.() ?? null;
    if (botNumber == null || callerSession == null)
      return this.err(
        "Not sent: WhatsApp through AbacusAI Bot's number is not available in this chat."
      );
    const message = String(args.message ?? "").trim();
    const ref = typeof args.media === "string" ? args.media.trim() : "";
    let media: Extract<ResolvedMedia, { ok: true }> | null = null;
    if (ref.length > 0) {
      const parsed = parseSendMedia({ media: ref, caption: message });
      if (parsed.ok === false) return this.err(`Not sent: ${parsed.reason}`);
      const resolved = botNumber.resolveMedia(ref, callerSession);
      if (resolved.ok === false)
        return this.err(`Not sent: ${resolved.reason}`);
      media = resolved;
    } else if (message.length === 0)
      return this.err("Not sent: there is no message.");
    else if (message.length > MAX_BOT_NUMBER_TEXT)
      return this.err(
        `Not sent: the message is too long (${message.length} characters, at most ${MAX_BOT_NUMBER_TEXT}). Shorten it.`
      );
    const outcome = await botNumber.notify(message, media);
    if (outcome.sent === true) return this.ok("Sent to the user's WhatsApp.");
    if (outcome.unconfirmed === true)
      return this.ok(
        `Unconfirmed: ${outcome.reason}. Do not send it again unless the user says it did not arrive, and do not tell them it failed.`
      );
    return this.err(
      `Not sent: ${outcome.reason}. Tell the user in one short line, in their language, and give them the content here instead. Never say it was sent.`
    );
  }

  /**
   * List the catalog, connected or not, so the agent can name what it lacks;
   * or ask, which never waits on the user. The ask resolves display names as
   * well as ids, forgivingly: Gmail's id is `gmailuser`, and any name the tool
   * can print the model may ask for. Facts only: each chat surface words the
   * outcome (tools/connectors.ts, tools/phone/connectors.ts). `card` puts a
   * Connect card up in the app beside the link, for a surface that has one.
   */
  async connectConnectorOutcome(
    args: Record<string, unknown>,
    callerSession: string | undefined,
    options: { card: boolean }
  ): Promise<ConnectOutcome> {
    const connectors = this.options.connectors;
    if (connectors == null) return { code: "no_connectors" };

    // A caller with no conversation gets no card: putting it "wherever the
    // user is" lands a bot's ask in a stranger's session. It still gets a link.
    const conversationKey =
      callerSession == null || !options.card
        ? null
        : (this.options.conversationKeyForSession?.(callerSession) ?? null);

    const statuses = await connectors.list();
    const statusOf = (connector: Connector): ConnectorStatus =>
      statuses[connector.id] ?? { state: "available" };
    const named = (item: Connector) => ({ id: item.id, name: item.name });

    const asked = String(args.service ?? "").trim();

    if (asked.length === 0)
      return {
        code: "list",
        entries: CONNECTORS.map((connector) => ({
          connector,
          status: statusOf(connector),
        })),
      };

    const resolved = resolveConnector(asked);
    if ("ambiguous" in resolved)
      return {
        code: "ambiguous",
        asked,
        options: resolved.ambiguous.map(named),
      };
    const match = resolved.match;
    if (match == null)
      return { code: "unknown", asked, options: CONNECTORS.map(named) };

    const status = statusOf(match);

    if (status.state === "connected")
      return {
        code: "connected",
        name: match.name,
        kind: match.kind,
        ...(match.kind === "platform" && match.via != null
          ? { via: match.via }
          : {}),
        ...(status.account != null && status.account.length > 0
          ? { account: status.account }
          : {}),
        ...(status.botNumber === true ? { botNumber: true } : {}),
      };

    if (status.state === "unavailable")
      return {
        code: "unavailable",
        name: match.name,
        reason:
          status.reason === "not-signed-in" || status.reason === "not-offered"
            ? status.reason
            : "unreachable",
      };

    // Nothing here waits for the user: the call answers at once, a card (in
    // the app) and a link (anywhere) do the connecting, and the chat that
    // asked is told when it lands.
    const link =
      match.kind !== "messaging"
        ? await connectors.link(match.id, callerSession ?? null)
        : null;
    // A bundle's members already connected are no part of this link, and are
    // never watched: one already connected would read as this link landing.
    const already = new Set(
      (link?.connectorIds ?? [])
        .filter((id) => statuses[id]?.state === "connected")
        .concat(link?.connectedIds ?? [])
    );
    const asking = (link?.connectorIds ?? [match.id]).filter(
      (id) => !already.has(id)
    );
    // Every connector the link covers is already connected: it can only
    // reconnect them, and only the link's own completion says it landed.
    const reconnect = link != null && asking.length === 0;
    if (conversationKey != null)
      connectors.show({
        connectorId: match.id,
        label: match.name,
        conversationKey,
        ...(typeof args.reason === "string" && args.reason.length > 0
          ? { reason: args.reason }
          : {}),
      });
    connectors.watch({
      connectorIds: reconnect ? link.connectorIds : asking,
      sessionId: callerSession ?? null,
      ...(link?.requestId != null ? { requestId: link.requestId } : {}),
      ...(reconnect ? { byLinkOnly: true } : {}),
    });
    if (link == null)
      return {
        code: "no_link",
        name: match.name,
        kind: match.kind,
        card: conversationKey != null,
      };
    const nameOf = (id: string): string =>
      CONNECTORS.find((item) => item.id === id)?.name ?? id;
    if (reconnect)
      return {
        code: "reconnect",
        names: link.connectorIds.map(nameOf),
        url: link.url,
      };
    return {
      code: "link",
      asking: asking.map(nameOf),
      already: [...already].map(nameOf),
      url: link.url,
    };
  }

  /**
   * Drop one connector. A chat app is switched off only for a surface that
   * allows it (`chatApps`); the outcome is facts, worded per surface.
   */
  async disconnectConnectorOutcome(
    args: Record<string, unknown>,
    options: { chatApps: boolean }
  ): Promise<DisconnectOutcome> {
    const asked = String(args.service ?? "")
      .trim()
      .toLowerCase();
    if (asked.length === 0) return { code: "required" };

    const resolved = resolveConnector(asked);
    if ("ambiguous" in resolved)
      return {
        code: "ambiguous",
        asked,
        options: resolved.ambiguous.map((item) => ({
          id: item.id,
          name: item.name,
        })),
      };
    const match = resolved.match;
    if (match == null) return { code: "unknown", asked };

    // The same lever as the card in Settings, so "off" means one thing.
    if (match.kind === "messaging") {
      // The link to AbacusAI Bot's number is the user's to undo, in the app.
      const linkedToBotNumber =
        (await this.options.connectors?.list())?.[match.id]?.botNumber === true;
      if (!options.chatApps || linkedToBotNumber)
        return { code: "platform_off", name: match.name };
      const disable = this.options.messaging?.disablePlatform;
      if (disable == null) return { code: "no_messaging" };
      await disable(match.platform);
      return { code: "disconnected", name: match.name, kind: match.kind };
    }

    const connectors = this.options.connectors;
    if (connectors?.disconnect == null) return { code: "no_connectors" };

    const statuses = await connectors.list();
    if (statuses[match.id]?.state !== "connected")
      return { code: "not_connected", name: match.name };

    const error = await connectors.disconnect(match.id);
    if (error != null) return { code: "failed", error };
    return { code: "disconnected", name: match.name, kind: match.kind };
  }

  /**
   * What this bot has been doing in its other conversations, from the tail of
   * each owned agent log; the calling conversation is already in context.
   */
  myActivity(callerSession?: string): ToolResult {
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
        "No other conversations yet: everything you have done is in this one."
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

  async listChats(args: Record<string, unknown>): Promise<ToolResult> {
    const messaging = this.options.messaging;
    if (messaging == null) return this.messagingSetupHint();

    const platforms = messaging.runningPlatforms();
    if (platforms.length === 0) return this.messagingSetupHint();

    // A platform still booting is waited for, not reported empty.
    await messaging.awaitReady?.();
    const starting = messaging.startingPlatforms?.() ?? [];
    const startingNote =
      starting.length > 0
        ? `\n\nStill starting: ${starting.join(", ")} (linked, and reading who the user is and the chat list). ` +
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
          '. Pass a query, or platform: "<name>" to list one platform in full.'
        : "";
    const live = messaging.livePlatforms?.() ?? platforms;
    const down = platforms.filter((id) => !live.includes(id));
    // The header names what is actually up, not every started platform: the
    // model reads the header. The shared-bot lanes are spelled out so
    // "abacus_discord" is not read as the user's Discord.
    const connectedLine =
      live.length === 0
        ? "Connected platforms: none. Nothing is linked right now."
        : `Connected platforms: ${live.map(describePlatformForAgent).join(", ")}`;
    // Added to every answer for a platform started but not connected: its
    // address book is empty, which must read as "not linked", not "no
    // contacts".
    const downNote =
      down.length > 0
        ? `\n\nNot connected right now: ${down.join(", ")} (reconnecting or waiting to be linked again). ` +
          "Anything missing here may simply be out of reach until it is back; say so rather than " +
          "asking the user to supply it."
        : "";
    const selves = messaging.selfChats?.() ?? [];
    const selfRows = selves.map(
      (row) => `${row.platform}  ${row.chatId}  (the user, "me")`
    );

    // Linked but unable to say who as. Say so, or the model asks the user for
    // the number of the phone they just paired.
    const selfless = live.filter(
      (id) => !selves.some((row) => row.platform === id)
    );
    const selfNote =
      selfless.length > 0
        ? `\n\nWho the user is on ${selfless.join(", ")} is not known yet. ` +
          "Do not ask them for their own number or handle. Say you cannot " +
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
            "Nothing to list YET." + startingNote + downNote,
          ].join("\n")
        );
      }

      if (known === 0) {
        return this.ok(
          [
            connectedLine,
            "",
            ...(selfRows.length > 0 ? [...selfRows, ""] : []),
            "No chats yet. Nobody has messaged in and no address book has synced, so " +
              "there is nothing to search. Another query will not find anything: the " +
              "user has to be messaged first, or message in. On WhatsApp you can still " +
              "send to a phone number." +
              downNote +
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
            "the platform's read tool with `query`: it searches message content " +
            "through the platform's own search. Omit the query here to see every " +
            "name. On WhatsApp you can still send to a phone number." +
            downNote +
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
          "read tools. On WhatsApp a contact's or group's name IS its " +
          "chat id; there is no other id to look for." +
          hiddenNote,
        downNote + selfNote,
      ]
        .join("\n")
        .trimEnd()
    );
  }

  async readChatMessages(args: Record<string, unknown>): Promise<ToolResult> {
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
          `Nothing stored for that chat, and ${platform} is not connected right now: ` +
            "anything newer than the last sync is out of reach until it is back. " +
            "Say so rather than asking the user to name the chat differently."
        );

      if (query.length > 0)
        return this.ok(
          `No message containing "${query}" was found. The platform's own ` +
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
        `No ${platform} chats have unread messages right now. The user is caught up.`
      );
    return this.ok(
      [
        `${platform} chats with unread messages (${unread.rows.length}):`,
        "",
        ...unread.rows.map(
          (row) =>
            `${platform}  to: "${row.chatId}"  (${describeUnread(row.unreadCount)})`
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
        `No ${platform} chats have unread messages right now. The user is caught up.`
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
          `- ${chat.name} (${describeUnread(chat.unreadCount)})`,
          ...(rows.length === 0
            ? ["  (nothing readable; the messages may be media only)"]
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
        ? `\n\n${unread.rows.length - chats.length} more chat(s) have unread messages. List them with \`only_unread\` on the list tool and read them by name.`
        : "";
    return this.ok(sections.join("\n\n") + more);
  }

  /**
   * "Reply whenever X messages me" as one call. The user asking in the bot's
   * chat is the approval the pairing queue exists to collect.
   */
  autoReply(args: Record<string, unknown>, callerSession?: string): ToolResult {
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

    // `botsOnly` already guarantees a calling bot; this is the belt.
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
          `Several platforms are connected (${running.join(", ")}). Say which one the sender is on.`
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
        ? `${resolved.name} will be answered in a separate conversation of their own. Everything written there is delivered to them, as the user. Gather the user's instructions for that sender now (tone, goals, what not to say) and store them in memory.`
        : "No sender allowed yet. Allow one with allow_sender, or approve pending ones from the Connectors page.";

    return this.ok(
      action === "on" ? `Auto-reply is on. ${allowedLine}` : allowedLine
    );
  }

  // ── Integrations ─────────────────────────────────────────────────────────

  async xSearch(args: Record<string, unknown>): Promise<ToolResult> {
    if (!xSearchReady()) return this.err(xSearchSetupHint);

    const query = String(args.query ?? "").trim();

    if (query.length === 0) return this.err("A query is required.");

    return this.ok(await xSearch(query));
  }

  async homeAssistant(
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

  ok(text: string): ToolResult {
    return { content: [{ type: "text", text }] };
  }

  err(text: string): ToolResult {
    return { content: [{ type: "text", text }], isError: true };
  }
}
