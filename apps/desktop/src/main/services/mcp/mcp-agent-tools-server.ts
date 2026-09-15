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
import { artifactPathLine } from "#shared/deliverables";
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
import { locateHostFile } from "../workspace/host-path";
import type { SkillsService } from "../workspace/skills-service";
import { localMcpServerToken } from "./mcp-config-service";
import { agentTool, AGENT_TOOLS } from "./tools";
import type { ToolDefinition, ToolResult } from "./tools/definition";
import { readTranscriptTail } from "./transcript-tail";

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

const toolsetsFor = (definition: ToolDefinition): readonly string[] =>
  definition.toolsets === "always" ? [] : definition.toolsets;

const isToolEnabled = (
  definition: ToolDefinition,
  enabled: Set<string>
): boolean =>
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
    const enabled = this.options.enabledToolsets();

    return AGENT_TOOLS.some((definition) => isToolEnabled(definition, enabled));
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
            tools: AGENT_TOOLS.filter((definition) =>
              forEditor
                ? definition.name === "cronjob"
                : this.isListed(definition.name, enabled, forBot)
            ).map((definition) => ({
              name: definition.name,
              description: definition.description,
              inputSchema: definition.inputSchema,
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

  /**
   * `tools/call`, gated the same way `tools/list` is — re-checked here, so a
   * toolset switched off mid-session stops working even while the model
   * holds an older tool list. Public for the tests that call tools directly.
   */
  async executeTool(
    name: string,
    args: Record<string, unknown>,
    callerSession?: string
  ): Promise<ToolResult> {
    const definition = agentTool(name);

    if (definition == null) return this.err(`Unknown tool: ${name}`);

    const forEditor = this.isRoutineEditor(callerSession);
    if (forEditor && name !== "cronjob")
      return this.err("This session can only change its routine.");
    if (
      !forEditor &&
      !isToolEnabled(definition, this.options.enabledToolsets()) &&
      !(definition.botAlways === true && this.isBotCaller(callerSession))
    ) {
      return this.err(
        `The ${toolsetsFor(definition).join("/")} toolset is switched off in Capabilities.`
      );
    }

    if (definition.botsOnly === true && !this.isBotCaller(callerSession)) {
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
  private async fireOnCreate(jobId: string): Promise<boolean> {
    try {
      await this.options.runCronJob?.(jobId, "create");
      return true;
    } catch {
      return false;
    }
  }

  async cronjob(
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
  async serve(args: Record<string, unknown>): Promise<ToolResult> {
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

  async presentDeliverable(
    args: Record<string, unknown>,
    callerSession?: string
  ): Promise<ToolResult> {
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
    // The files card and the artifacts ledger read these, not the arguments.
    lines.push("", ...valid.map((item) => artifactPathLine(item.target)));

    return this.ok(lines.join("\n"));
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
          "Read the PDF back and look at it before showing the user — overflowing text is obvious in the render and invisible in the markup."
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
      `Submitted as job ${jobId}. Generation takes minutes — check it with bfl_flux3_get_result, polling every 20-30 seconds rather than continuously.`
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
  private isToolConfigured(definition: ToolDefinition): boolean {
    if (definition.hidden === true) {
      return (this.options.messaging?.runningPlatforms().length ?? 0) > 0;
    }
    // No Discord tools on a machine that never connected Discord.
    if (definition.platform != null)
      return (
        this.options.messaging
          ?.runningPlatforms()
          .includes(definition.platform) ?? false
      );
    return definition.ready?.() ?? true;
  }

  /** Whether `tools/list` shows a tool to this caller. */
  isListed(name: string, enabled: Set<string>, forBot: boolean): boolean {
    const definition = agentTool(name);
    if (definition == null || definition.hidden === true) return false;
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
        "send the user to Settings, and do not ask them for the number — " +
        `call connect_connector with service "${platform}": it puts a ` +
        "Connect button in front of the user right here and waits for them."
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
  async connectConnector(
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

  async disconnectConnector(
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
    const selfless = live.filter(
      (id) => !selves.some((row) => row.platform === id)
    );
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
            "No chats yet — nobody has messaged in and no address book has synced, so " +
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
            "the platform's read tool with `query` — it searches message content " +
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
          "read tools — on WhatsApp a contact's or group's name IS its " +
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

  private err(text: string): ToolResult {
    return { content: [{ type: "text", text }], isError: true };
  }
}
