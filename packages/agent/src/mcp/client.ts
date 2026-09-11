/**
 * A minimal MCP client: `initialize`, `tools/list`, `tools/call`, hand-rolled
 * because the SDK would add a dependency and a transport negotiation for three
 * methods. Two transports: http (POST JSON-RPC, answered as plain JSON or a
 * short SSE stream, echoing `Mcp-Session-Id` once issued) and stdio
 * (newline-delimited JSON-RPC over a spawned server's stdin/stdout).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { resolveSpawn } from "./windows-spawn.js";

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface McpTransport {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): void;
}

const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "abacusai-bot", version: "1.0.0" };
/**
 * A server that cannot answer `initialize` or `tools/list` in a minute is
 * broken. A `tools/call` is arbitrary work (the pdf and deck tools run several
 * generation passes behind one call), so it gets its own, far longer ceiling.
 */
const REQUEST_TIMEOUT_MS = 60_000;
const TOOL_CALL_TIMEOUT_MS = 15 * 60_000;

const timeoutFor = (method: string): number =>
  method === "tools/call" ? TOOL_CALL_TIMEOUT_MS : REQUEST_TIMEOUT_MS;

/** How much of a stdio server's stderr to keep for its exit message. */
const STDERR_TAIL_CHARS = 4000;
const STDERR_DETAIL_CHARS = 300;

/**
 * The one stderr line worth quoting when a server dies: the error line if
 * there is one (Node prints it above the stack), else the last non-frame line.
 */
export function stderrDetail(tail: string): string | null {
  const lines = tail
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("at "));
  const picked =
    lines.find((line) => /^(\w*Error|error)\b/.test(line)) ?? lines.at(-1);
  return picked != null ? picked.slice(0, STDERR_DETAIL_CHARS) : null;
}

/**
 * An HTTP-level failure, distinct from protocol failures because the status is
 * a decision: 401 means "sign in", not "broken". `WWW-Authenticate` rides along
 * because it points at the protected-resource metadata (RFC 9728) that starts
 * the sign-in flow.
 */
export class McpHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly wwwAuthenticate: string | null
  ) {
    super(message);
    this.name = "McpHttpError";
  }
}

class HttpTransport implements McpTransport {
  private nextId = 0;
  /**
   * Streamable-HTTP session, if the server opened one: every request after
   * the `Mcp-Session-Id` header appears must echo it.
   */
  private sessionId: string | null = null;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
    private readonly refuseRedirects = false
  ) {}

  /**
   * fetch strips `Authorization` on a cross-origin redirect but forwards every
   * other header, so a server could 302 a credential away under its own header
   * name. With a credential attached, redirects are an error instead.
   */
  private get redirectMode(): "error" | "follow" {
    return this.refuseRedirects ? "error" : "follow";
  }

  private requestHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      // Both types: streamable-HTTP servers answer 406 to a client that
      // cannot take an SSE response.
      Accept: "application/json, text/event-stream",
      ...(this.sessionId != null ? { "Mcp-Session-Id": this.sessionId } : {}),
      ...this.headers,
    };
  }

  /**
   * The JSON-RPC message out of a response, whether framed as a plain JSON
   * body or as a short SSE stream. For SSE the `data:` line answering our id
   * wins; keep-alives and unrelated events fall through.
   */
  private async parseResponse(
    response: Response,
    id: number
  ): Promise<JsonRpcResponse> {
    const contentType = response.headers.get("content-type") ?? "";

    if (!contentType.includes("text/event-stream")) {
      return (await response.json()) as JsonRpcResponse;
    }

    const text = await response.text();
    let fallback: JsonRpcResponse | null = null;

    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;

      try {
        const message = JSON.parse(line.slice(5).trim()) as JsonRpcResponse;

        if (message.id === id) return message;
        if (
          fallback == null &&
          (message.result !== undefined || message.error != null)
        )
          fallback = message;
      } catch {
        // Keep-alive or partial frame; not ours.
      }
    }

    if (fallback != null) return fallback;

    throw new Error(
      "The server answered with an event stream that contained no JSON-RPC response."
    );
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.nextId;
    const response = await fetch(this.url, {
      method: "POST",
      headers: this.requestHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...(params != null ? { params } : {}),
      }),
      redirect: this.redirectMode,
      signal: AbortSignal.timeout(timeoutFor(method)),
    });

    if (!response.ok) {
      throw new McpHttpError(
        `${method} failed: HTTP ${response.status}`,
        response.status,
        response.headers.get("www-authenticate")
      );
    }

    const issuedSession = response.headers.get("mcp-session-id");

    if (issuedSession != null) this.sessionId = issuedSession;

    const body = await this.parseResponse(response, id);

    if (body.error != null) {
      throw new Error(body.error.message ?? `${method} failed`);
    }

    return body.result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    // No id, no response expected; a server that ignores notifications is
    // still usable, so failures are dropped.
    await fetch(this.url, {
      method: "POST",
      headers: this.requestHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        ...(params != null ? { params } : {}),
      }),
      redirect: this.redirectMode,
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  }

  close(): void {
    // No process to kill; any server-side session dies with its TTL.
  }
}

class StdioTransport implements McpTransport {
  private nextId = 0;
  private buffer = "";
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly child: ChildProcessWithoutNullStreams;
  private stderrTail = "";
  /** Set once the child is gone, so later requests fail now, not at timeout. */
  private exited: Error | null = null;

  constructor(command: string, args: string[], env: Record<string, string>) {
    // Windows .cmd shims cannot be spawned directly (see windows-spawn.ts).
    // Resolution takes the CHILD's environment: that is the PATH the command
    // resolves against and what cmd.exe expands %NAME% from.
    const childEnv = { ...process.env, ...env };
    const spec = resolveSpawn(command, args, process.platform, childEnv);

    this.child = spawn(spec.file, spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
      ...(spec.windowsVerbatimArguments === true
        ? { windowsVerbatimArguments: true }
        : {}),
    });

    this.child.stdout.on("data", (chunk: Buffer) =>
      this.onData(chunk.toString())
    );
    // EPIPE on a dead server's stdin would otherwise be an uncaught exception
    // that kills the whole agent; 'exit' already fails pending requests.
    this.child.stdin.on("error", () => {});
    // Forwarded so the server's log lands in the app's logs.
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      // Kept for the exit error: a server that dies on spawn says why here
      // and nowhere else.
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARS);
      process.stderr.write(`[mcp] ${text}`);
    });
    this.child.on("exit", (code, signal) => {
      const reason =
        code != null ? `exit code ${code}` : signal != null ? signal : "exited";
      const detail = stderrDetail(this.stderrTail);
      this.exited = new Error(
        detail != null
          ? `MCP server exited (${reason}): ${detail}`
          : `MCP server exited (${reason})`
      );
      this.failAll(this.exited);
    });
    this.child.on("error", (error) => {
      this.exited = error;
      this.failAll(error);
    });
  }

  private onData(text: string): void {
    this.buffer += text;

    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim().length === 0) continue;

      let message: JsonRpcResponse;

      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }

      if (typeof message.id !== "number") continue;

      const waiter = this.pending.get(message.id);

      if (waiter == null) continue;

      this.pending.delete(message.id);

      if (message.error != null)
        waiter.reject(new Error(message.error.message ?? "MCP error"));
      else waiter.resolve(message.result);
    }
  }

  private failAll(error: Error): void {
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id);
      waiter.reject(error);
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.exited != null) throw this.exited;

    const id = ++this.nextId;

    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeoutFor(method));

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });

    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params != null ? { params } : {}) })}\n`
    );

    return promise;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, ...(params != null ? { params } : {}) })}\n`
    );
  }

  close(): void {
    // EOF on stdin first: a well-behaved server exits when its input closes.
    try {
      this.child.stdin.end();
    } catch {
      /* stream already gone */
    }

    killServerTree(this.child);
  }
}

/** The subset of `spawn` the tree kill needs, so a test can stand in for it. */
export type SpawnLike = (
  file: string,
  args: string[],
  options: { stdio: "ignore"; windowsHide: boolean }
) => {
  on: (event: "error" | "exit", listener: (arg: unknown) => void) => unknown;
};

/**
 * Stop a spawned server and everything it started. On Windows the child is the
 * cmd.exe wrapper, so kill() would orphan the real server; taskkill /T takes
 * the tree. taskkill can be missing or fail (tree gone, elevated child), and
 * killing the wrapper still beats leaving the server running.
 */
export function killServerTree(
  child: { pid?: number; kill: () => void },
  platform: NodeJS.Platform = process.platform,
  spawnProcess: SpawnLike = spawn as unknown as SpawnLike
): void {
  if (platform !== "win32" || child.pid == null) {
    child.kill();

    return;
  }

  let fellBack = false;
  const fallback = (): void => {
    if (fellBack) return;

    fellBack = true;
    child.kill();
  };

  try {
    // windowsHide: taskkill would otherwise flash a console window.
    const killer = spawnProcess(
      "taskkill",
      ["/pid", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true }
    );

    killer.on("error", fallback);
    killer.on("exit", (code) => {
      if (code !== 0) fallback();
    });
  } catch {
    fallback();
  }
}

/** One connected MCP server. */
export class McpClient {
  private constructor(
    readonly name: string,
    private readonly transport: McpTransport,
    readonly tools: McpToolInfo[]
  ) {}

  /**
   * Connect, handshake, and discover tools. Throws on any failure: an
   * unreachable server must not be half-registered with tools that error.
   */
  static async connect(
    name: string,
    transport: McpTransport
  ): Promise<McpClient> {
    await transport.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });

    await transport.notify("notifications/initialized");

    const listed = (await transport.request("tools/list")) as
      | { tools?: McpToolInfo[] }
      | undefined;

    return new McpClient(name, transport, listed?.tools ?? []);
  }

  static httpTransport(
    url: string,
    headers?: Record<string, string>,
    options: { refuseRedirects?: boolean } = {}
  ): McpTransport {
    return new HttpTransport(url, headers ?? {}, options.refuseRedirects);
  }

  static stdioTransport(
    command: string,
    args: string[],
    env: Record<string, string>
  ): McpTransport {
    return new StdioTransport(command, args, env);
  }

  /**
   * Call a tool: text flattened for the model, plus the raw blocks for callers
   * that handle blob resources (see mcp/attachments.ts).
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{
    text: string;
    isError: boolean;
    blocks: Array<Record<string, unknown>>;
  }> {
    const result = (await this.transport.request("tools/call", {
      name: toolName,
      arguments: args,
    })) as
      | { content?: Array<Record<string, unknown>>; isError?: boolean }
      | undefined;

    const blocks = result?.content ?? [];
    const text = blocks
      .map((block) =>
        block.type === "text"
          ? String(block.text ?? "")
          : block.type === "resource"
            ? // The caller saves it to disk and reports the path.
              ""
            : `[${typeof block.type === "string" ? block.type : "content"}]`
      )
      .filter((line) => line.length > 0)
      .join("\n");

    return { text, isError: result?.isError === true, blocks };
  }

  close(): void {
    this.transport.close();
  }
}
