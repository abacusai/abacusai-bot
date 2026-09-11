import fs from "fs";
import http from "http";
import net from "net";
import path from "path";

import { DeviceService, type DevicePlatform } from "../device/device-service";
import { localMcpServerToken } from "./mcp-config-service";

/**
 * Built-in MCP server ("device") exposing iOS simulators and Android devices
 * to the local Code agent. Same HTTP JSON-RPC shape as McpBrowserServer; the
 * driving lives in DeviceService. Injected only when xcrun or adb is present.
 */

interface ToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
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

const SERVER_NAME = "device";
const SERVER_VERSION = "1.0.0";

const PLATFORM_PROP = {
  type: "string",
  enum: ["ios", "android"],
  description:
    'Target platform ("ios" = simulator via simctl, "android" = emulator/device via adb)',
};
const DEVICE_PROP = {
  type: "string",
  description:
    "Optional device UDID/serial or (partial) name. Defaults to the booted device on that platform.",
};

const TOOLS_SCHEMA: Record<
  string,
  { description: string; inputSchema: Record<string, unknown> }
> = {
  device_list: {
    description:
      "List available iOS simulators and Android emulators/devices with their state (booted/shutdown). Use this first to pick a target.",
    inputSchema: { type: "object", properties: {} },
  },
  device_boot: {
    description:
      "Boot a simulator/emulator (and open its window). Omit device to boot the first available one. Blocks until the OS has finished booting.",
    inputSchema: {
      type: "object",
      properties: { platform: PLATFORM_PROP, device: DEVICE_PROP },
      required: ["platform"],
    },
  },
  device_shutdown: {
    description: "Shut down a booted simulator/emulator.",
    inputSchema: {
      type: "object",
      properties: { platform: PLATFORM_PROP, device: DEVICE_PROP },
      required: ["platform"],
    },
  },
  device_build: {
    description: [
      "Build the active workspace for the simulator/emulator and return the artifact path + app id.",
      "Omit platform to auto-detect it from the project layout (required only when the project targets both iOS and Android).",
      "iOS: finds the .xcworkspace/.xcodeproj (root or ./ios), builds with xcodebuild for the iOS Simulator, returns the .app path and bundle id.",
      "Android: runs ./gradlew assembleDebug (root or ./android), returns the debug APK path and applicationId.",
      "Flutter / React Native: run the framework build via the shell instead, then use device_app install with the produced artifact.",
      "Builds can take several minutes.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        platform: {
          ...PLATFORM_PROP,
          description: `${PLATFORM_PROP.description}. Optional — auto-detected from the project when unambiguous.`,
        },
        scheme: {
          type: "string",
          description:
            "iOS only: Xcode scheme (defaults to the first listed scheme)",
        },
        configuration: {
          type: "string",
          description: 'iOS only: build configuration (default "Debug")',
        },
      },
    },
  },
  device_app: {
    description: [
      "Manage an app on a device. Actions:",
      '  "install"   — install an artifact (params: path to .app dir / .apk)',
      '  "launch"    — launch by app id (params: appId = iOS bundle id / Android package)',
      '  "terminate" — force-stop the app (params: appId)',
      '  "uninstall" — remove the app (params: appId)',
      '  "open_url"  — open a URL / deep link on the device (params: url)',
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["install", "launch", "terminate", "uninstall", "open_url"],
          description: "App action",
        },
        platform: PLATFORM_PROP,
        device: DEVICE_PROP,
        path: {
          type: "string",
          description:
            'Artifact path for "install" (.app directory on iOS, .apk on Android)',
        },
        appId: {
          type: "string",
          description:
            "iOS bundle id / Android package for launch/terminate/uninstall",
        },
        url: { type: "string", description: 'URL or deep link for "open_url"' },
      },
      required: ["action", "platform"],
    },
  },
  device_screenshot: {
    description:
      "Capture a screenshot of a booted device. Saves a PNG to disk and returns the file path — Read the file to see the screen. Use after every meaningful UI change.",
    inputSchema: {
      type: "object",
      properties: { platform: PLATFORM_PROP, device: DEVICE_PROP },
      required: ["platform"],
    },
  },
  device_snapshot: {
    description: [
      "Capture the current UI element tree (Android: uiautomator; iOS: Maestro — requires the Maestro binary on the host).",
      "Returns interactive elements with @eN refs usable in device_interact (refs valid until the next snapshot or screen change).",
      "If the tree is empty or unavailable, fall back to device_screenshot.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: { platform: PLATFORM_PROP, device: DEVICE_PROP },
      required: ["platform"],
    },
  },
  device_interact: {
    description: [
      "Interact with the device screen. Prefer @eN refs from the latest device_snapshot; raw x/y coordinates work as a fallback (e.g. from a screenshot).",
      "Android runs natively via adb; iOS requires the Maestro binary on the host (the tool explains how to install it if missing).",
      "Actions:",
      "  tap        — tap an element or point (params: ref OR x+y)",
      "  long_press — press and hold (params: ref OR x+y)",
      "  swipe / scroll — scroll the screen (params: direction up/down/left/right, amount px)",
      "  type       — type text into the focused input (tap the field first)",
      "  press_key  — press a key (params: key = enter/back/home/delete; Android also tab/menu or raw KEYCODE_*)",
      "  wait       — wait (params: amount ms, default 2000)",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        platform: PLATFORM_PROP,
        action: {
          type: "string",
          enum: [
            "tap",
            "long_press",
            "swipe",
            "scroll",
            "type",
            "press_key",
            "wait",
          ],
          description: "Interaction action",
        },
        ref: {
          type: "string",
          description:
            'Element ref from the latest device_snapshot (e.g. "@e3")',
        },
        x: { type: "number", description: "X coordinate (when no ref)" },
        y: { type: "number", description: "Y coordinate (when no ref)" },
        text: { type: "string", description: 'Text for the "type" action' },
        key: { type: "string", description: 'Key name for "press_key"' },
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Scroll/swipe direction",
        },
        amount: {
          type: "number",
          description: "Scroll distance px, or wait duration ms",
        },
        device: DEVICE_PROP,
      },
      required: ["action", "platform"],
    },
  },
  device_logs: {
    description: [
      "Read recent device logs (iOS: unified log via `log show --last 2m`; Android: logcat).",
      "Always pass a filter (regex) and/or appId to avoid noise — raw device logs are extremely verbose.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        platform: PLATFORM_PROP,
        device: DEVICE_PROP,
        lines: {
          type: "number",
          description: "Max lines to return (default 200, max 2000)",
        },
        filter: {
          type: "string",
          description:
            "Case-insensitive regex applied per line. It is evaluated under a time limit; a pattern that does not finish in time, or one that is not valid, is reported as an error rather than applied.",
        },
        appId: {
          type: "string",
          description: "iOS: filter to this app's process",
        },
      },
      required: ["platform"],
    },
  },
};

/** Read-only tools skip the permission prompt; cf. isReadOnlyBrowserTool. */
function isReadOnlyDeviceTool(name: string): boolean {
  return (
    name === "device_list" ||
    name === "device_screenshot" ||
    name === "device_snapshot" ||
    name === "device_logs"
  );
}

const SUMMARY_VALUE_LIMIT = 120;

/** One argument, as the approval prompt should show it. */
function summarizeValue(value: unknown): string {
  if (typeof value !== "string") return "";
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > SUMMARY_VALUE_LIMIT
    ? `${oneLine.slice(0, SUMMARY_VALUE_LIMIT)}…`
    : oneLine;
}

/**
 * What the approval prompt shows. A "type" payload belongs here: it is what
 * reaches the device, and an approval that hides it approves something unseen.
 */
export function summarizeDeviceToolCall(
  name: string,
  args: Record<string, unknown>
): string {
  const platform = typeof args.platform === "string" ? args.platform : "";
  switch (name) {
    case "device_boot":
      return `Boot ${platform} device ${args.device ?? "(default)"}`;
    case "device_shutdown":
      return `Shut down ${platform} device ${args.device ?? "(default)"}`;
    case "device_build":
      return `Build the workspace for ${platform}`;
    case "device_app":
      return `${args.action ?? "app action"} ${args.appId ?? args.path ?? args.url ?? ""} (${platform})`;
    case "device_interact": {
      const action = typeof args.action === "string" ? args.action : "interact";
      if (action === "type")
        return `type "${summarizeValue(args.text)}" (${platform})`;
      if (action === "press_key")
        return `press key ${summarizeValue(args.key)} (${platform})`;
      return `${action} ${args.ref ?? ""}`.trim();
    }
    default:
      return name;
  }
}

// Every downstream branch reads "ios" or else drives adb, so an unchecked
// unknown platform would silently become Android.
export function parseDevicePlatform(value: unknown): DevicePlatform | null {
  return value === "ios" || value === "android" ? value : null;
}

function realPathOf(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * Where an install artifact may come from. The model-supplied path goes
 * straight to `simctl install` / `adb install`, so it must look like the
 * platform's package and sit in the workspace (symlinks followed) or come
 * from a device_build (see builtArtifacts).
 */
export function resolveInstallArtifact(
  rawPath: string,
  workspacePath: string | null,
  platform: DevicePlatform,
  builtArtifacts: ReadonlySet<string> = new Set()
): { path: string } | { error: string } {
  const expected = platform === "ios" ? ".app" : ".apk";
  const trimmed = rawPath.trim();
  if (path.extname(trimmed).toLowerCase() !== expected) {
    return { error: `install expects a ${expected} artifact on ${platform}.` };
  }
  const candidate =
    workspacePath == null
      ? path.resolve(trimmed)
      : path.resolve(workspacePath, trimmed);
  const real = realPathOf(candidate);
  if (real == null) return { error: `Artifact not found: ${candidate}` };
  if (builtArtifacts.has(real)) return { path: real };
  const root = workspacePath == null ? null : realPathOf(workspacePath);
  const fold = (p: string): string =>
    process.platform === "win32" || process.platform === "darwin"
      ? p.toLowerCase()
      : p;
  const relative = root == null ? ".." : path.relative(fold(root), fold(real));
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return {
      error:
        "Install artifacts must live inside the workspace, or be the artifact device_build produced.",
    };
  }
  return { path: real };
}

export interface McpDeviceServerOptions {
  /** Gate consulted before each non-read-only tool call. */
  requestPermission?: (
    tool: string,
    summary: string,
    sessionId?: string
  ) => Promise<"allow" | "deny">;
  /** Resolves the active local-Code workspace path for device_build. */
  resolveWorkspacePath?: () => string | null;
  /** Shared driver instance (ServiceHost also uses it for the mirror panel). */
  deviceService?: DeviceService;
}

export class McpDeviceServer {
  private server: http.Server | null = null;
  private port: number | null = null;
  private activeSessions = new Map<
    string,
    { transport: "sse"; res: http.ServerResponse }
  >();
  private sessionCounter = 0;
  private readonly deviceService: DeviceService;
  /**
   * Real paths of every artifact device_build has produced since launch,
   * app-wide. iOS builds need the exception: they land in DerivedData,
   * wherever `xcodebuild -showBuildSettings` says. Nothing else belongs here.
   */
  private readonly builtArtifacts = new Set<string>();

  constructor(private readonly options: McpDeviceServerOptions = {}) {
    this.deviceService = options.deviceService ?? new DeviceService();
  }

  /** True when a mobile toolchain (xcrun or adb) exists on this host. */
  isToolchainAvailable(): boolean {
    return this.deviceService.isAvailable();
  }

  async start(): Promise<number> {
    if (this.server != null) return this.port!;
    const port = await this.findAvailablePort();
    this.port = port;
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    return new Promise((resolve, reject) => {
      this.server!.listen(port, "127.0.0.1", () => {
        resolve(port);
      });
      this.server!.on("error", reject);
    });
  }

  stop(): void {
    for (const [, session] of this.activeSessions) {
      try {
        session.res.end();
      } catch {
        /* ignore */
      }
    }
    this.activeSessions.clear();
    if (this.server != null) {
      this.server.close();
      this.server = null;
      this.port = null;
    }
  }

  getPort(): number | null {
    return this.port;
  }
  isRunning(): boolean {
    return this.server != null;
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

    // No CORS headers: a wildcard origin would let any page the user browsed
    // call tools/call on loopback.
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
    this.activeSessions.set(sessionId, { transport: "sse", res });
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
        // The URL carries the session id, which is how a prompt knows whether
        // the asking session is in Bypass mode.
        const agentSessionId =
          new URL(
            req.url ?? "/",
            `http://localhost:${this.port}`
          ).searchParams.get("session") ?? undefined;
        const response = await this.processJsonRpc(request, agentSessionId);
        const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);
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
      if (session) {
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
    sessionId?: string
  ): Promise<JsonRpcResponse> {
    const { method, params, id } = request;
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        };
      case "notifications/initialized":
        return { jsonrpc: "2.0", id: id ?? null, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            tools: Object.entries(TOOLS_SCHEMA).map(([name, s]) => ({
              name,
              description: s.description,
              inputSchema: s.inputSchema,
            })),
          },
        };
      case "tools/call": {
        const toolName = (params as { name?: string })?.name ?? "";
        const toolArgs = ((params as { arguments?: Record<string, unknown> })
          ?.arguments ?? {}) as Record<string, unknown>;
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: await this.executeTool(toolName, toolArgs, sessionId),
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

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<ToolResult> {
    try {
      if (
        this.options.requestPermission != null &&
        !isReadOnlyDeviceTool(name)
      ) {
        const decision = await this.options.requestPermission(
          name,
          summarizeDeviceToolCall(name, args),
          sessionId
        );
        if (decision === "deny") {
          return this.err("Device permission denied by user.");
        }
      }
      const platform = parseDevicePlatform(args.platform);
      if (platform == null && args.platform != null) {
        return this.err(
          `Unknown platform ${JSON.stringify(args.platform)} — use "ios" or "android".`
        );
      }
      // device_build auto-detects; snapshot/interact default to Android.
      const requirePlatform = (): DevicePlatform => {
        if (platform == null) throw new Error(`${name} requires platform.`);
        return platform;
      };
      const device = args.device as string | undefined;
      switch (name) {
        case "device_list": {
          const devices = await this.deviceService.listDevices();
          if (devices.length === 0)
            return this.ok(
              "No devices found. iOS requires Xcode (macOS); Android requires the Android SDK with at least one AVD."
            );
          const lines = devices.map(
            (d) =>
              `[${d.platform}] ${d.name} — ${d.state}${d.os != null ? ` (${d.os})` : ""}${d.physical === true ? " (physical)" : ""} id=${d.id}`
          );
          return this.ok(lines.join("\n"));
        }
        case "device_boot": {
          const booted = await this.deviceService.boot(
            requirePlatform(),
            device
          );
          return this.ok(`Booted ${booted.name} (${booted.id}).`);
        }
        case "device_shutdown": {
          await this.deviceService.shutdown(requirePlatform(), device);
          return this.ok("Device shut down.");
        }
        case "device_build": {
          const workspacePath = this.options.resolveWorkspacePath?.() ?? null;
          if (workspacePath == null) return this.err("No active workspace.");
          let buildPlatform = platform;
          if (buildPlatform == null) {
            const project =
              this.deviceService.detectProjectPlatforms(workspacePath);
            if (project.ios && project.android)
              return this.err(
                "Project targets both iOS and Android — pass platform explicitly."
              );
            if (project.ios) buildPlatform = "ios";
            else if (project.android) buildPlatform = "android";
            else
              return this.err(
                "No iOS or Android project detected in the workspace (looked for .xcworkspace/.xcodeproj and gradlew at the root and ./ios / ./android)."
              );
          }
          const result = await this.deviceService.build(
            workspacePath,
            buildPlatform,
            {
              scheme: args.scheme as string | undefined,
              configuration: args.configuration as string | undefined,
            }
          );
          if (!result.success)
            return this.err(`Build failed:\n${result.output}`);
          if (result.artifactPath != null) {
            const real = realPathOf(result.artifactPath);
            if (real != null) this.builtArtifacts.add(real);
          }
          return this.ok(
            `Build succeeded.\nartifact: ${result.artifactPath}\n${result.appId != null ? `appId: ${result.appId}\n` : ""}` +
              `Next: device_app action:"install" path:"${result.artifactPath}", then action:"launch" appId:"${result.appId ?? "<app id>"}".`
          );
        }
        case "device_app": {
          const action = args.action as string;
          const appPlatform = requirePlatform();
          if (action === "install") {
            const artifact = args.path as string | undefined;
            if (artifact == null) return this.err("install requires path.");
            const resolved = resolveInstallArtifact(
              artifact,
              this.options.resolveWorkspacePath?.() ?? null,
              appPlatform,
              this.builtArtifacts
            );
            if ("error" in resolved) return this.err(resolved.error);
            const target = await this.deviceService.installApp(
              appPlatform,
              resolved.path,
              device
            );
            return this.ok(`Installed on ${target.name}.`);
          }
          if (action === "open_url") {
            const urlArg = args.url as string | undefined;
            if (urlArg == null) return this.err("open_url requires url.");
            await this.deviceService.openUrl(appPlatform, urlArg, device);
            return this.ok(`Opened ${urlArg}.`);
          }
          const appId = args.appId as string | undefined;
          if (appId == null) return this.err(`${action} requires appId.`);
          if (action === "launch") {
            const target = await this.deviceService.launchApp(
              appPlatform,
              appId,
              device
            );
            return this.ok(
              `Launched ${appId} on ${target.name}. Use device_screenshot to see the result.`
            );
          }
          if (action === "terminate") {
            await this.deviceService.terminateApp(appPlatform, appId, device);
            return this.ok(`Terminated ${appId}.`);
          }
          if (action === "uninstall") {
            await this.deviceService.uninstallApp(appPlatform, appId, device);
            return this.ok(`Uninstalled ${appId}.`);
          }
          return this.err(`Unknown action "${action}".`);
        }
        case "device_screenshot": {
          const shot = await this.deviceService.screenshot(
            requirePlatform(),
            device
          );
          return this.ok(
            `Screenshot saved: ${shot.file}\nRead this file to view the screen.${shot.note}`
          );
        }
        case "device_snapshot": {
          return this.ok(
            await this.deviceService.snapshot(platform ?? "android", device)
          );
        }
        case "device_interact": {
          return this.ok(
            await this.deviceService.interact(platform ?? "android", {
              action: args.action as string,
              ref: args.ref as string | undefined,
              x: args.x as number | undefined,
              y: args.y as number | undefined,
              text: args.text as string | undefined,
              key: args.key as string | undefined,
              direction: args.direction as string | undefined,
              amount: args.amount as number | undefined,
              deviceId: device,
            })
          );
        }
        case "device_logs": {
          const logs = await this.deviceService.logs(requirePlatform(), {
            lines: args.lines as number | undefined,
            filter: args.filter as string | undefined,
            appId: args.appId as string | undefined,
            deviceId: device,
          });
          return this.ok(logs !== "" ? logs : "No matching log lines.");
        }
        default:
          return this.err(`Unknown tool: ${name}`);
      }
    } catch (e) {
      return this.err(e instanceof Error ? e.message : String(e));
    }
  }

  private ok(text: string): ToolResult {
    return { content: [{ type: "text", text }] };
  }
  private err(text: string): ToolResult {
    return { content: [{ type: "text", text }], isError: true };
  }
}
