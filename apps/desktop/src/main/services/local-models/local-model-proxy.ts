/**
 * The loopback endpoint the agent talks to for `local/*` models. It stands in
 * front of the llama.cpp server so that the address written into config.json
 * never changes, the model loads on the first request rather than at app
 * start, a request for a different installed model swaps what is loaded,
 * and a machine quiet for a while gives the memory back.
 *
 * Requests are forwarded byte for byte, streaming responses included; the
 * body is read first only to learn which model is being asked for.
 */
import http from "node:http";

export interface UpstreamServer {
  readonly modelId: string;
  readonly baseUrl: string;
  readonly running: boolean;
  start(): Promise<void>;
  stop(): void;
}

export interface ProxyOptions {
  /** A server for the model, or null when it is not installed. */
  serverFor: (modelId: string) => UpstreamServer | null;
  /** When no request named a model: the one to serve, or null. */
  defaultModelId: () => string | null;
  /** Stop the loaded model after this long without a request. */
  idleMs?: number;
  /** Test seam. */
  now?: () => number;
}

/** The port tried first; config.json carries whichever one was free. */
export const PREFERRED_PROXY_PORT = 41434;

const IDLE_MS = 15 * 60_000;

const readBody = (request: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

/** The `model` field of an OpenAI-style request body, if there is one. */
export const modelInBody = (body: Buffer): string | null => {
  if (body.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    const model =
      parsed != null && typeof parsed === "object"
        ? (parsed as { model?: unknown }).model
        : undefined;
    return typeof model === "string" && model.length > 0 ? model : null;
  } catch {
    return null;
  }
};

const fail = (
  response: http.ServerResponse,
  status: number,
  message: string
): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message, type: "local_model" } }));
};

export class LocalModelProxy {
  private server: http.Server | null = null;
  private port = 0;
  private upstream: UpstreamServer | null = null;
  /** One start at a time: concurrent first requests share it. */
  private starting: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private inFlight = 0;

  constructor(private readonly options: ProxyOptions) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  get servingId(): string | null {
    return this.upstream?.running === true ? this.upstream.modelId : null;
  }

  /** Listen on the preferred port, or the next free one. */
  async listen(preferred = PREFERRED_PROXY_PORT): Promise<number> {
    if (this.server != null) return this.port;
    const server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    for (let port = preferred; port < preferred + 20; port++) {
      const bound = await new Promise<boolean>((resolve) => {
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => {
          server.removeAllListeners("error");
          resolve(true);
        });
      });
      if (bound) {
        this.server = server;
        this.port = port;
        return port;
      }
    }
    throw new Error("no free loopback port for the local model endpoint");
  }

  /** Unload the model and stop answering; the process is quitting. */
  close(): void {
    this.clearIdle();
    this.upstream?.stop();
    this.upstream = null;
    this.server?.close();
    this.server = null;
  }

  /** Unload whatever is loaded (a model was removed, or the machine is idle). */
  unload(): void {
    this.clearIdle();
    this.upstream?.stop();
    this.upstream = null;
  }

  private clearIdle(): void {
    if (this.idleTimer != null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private touch(): void {
    this.clearIdle();
    if (this.inFlight > 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.inFlight === 0) this.unload();
    }, this.options.idleMs ?? IDLE_MS);
    this.idleTimer.unref();
  }

  /** The server for `modelId`, loaded; swaps out any other loaded model. */
  private async ensure(modelId: string): Promise<UpstreamServer> {
    if (this.starting != null) await this.starting;
    const current = this.upstream;
    if (current != null && current.modelId === modelId && current.running)
      return current;
    const next = this.options.serverFor(modelId);
    if (next == null) throw new Error(`no local model named ${modelId}`);
    this.starting = (async () => {
      current?.stop();
      this.upstream = next;
      await next.start();
    })().finally(() => {
      this.starting = null;
    });
    await this.starting;
    return next;
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    this.inFlight += 1;
    this.clearIdle();
    try {
      const body = await readBody(request);
      const modelId = modelInBody(body) ?? this.options.defaultModelId();
      if (modelId == null) {
        fail(response, 503, "no local model is installed");
        return;
      }
      let upstream: UpstreamServer;
      try {
        upstream = await this.ensure(modelId);
      } catch (error) {
        fail(
          response,
          503,
          `the local model could not start: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return;
      }
      await this.forward(upstream, request, body, response);
    } finally {
      this.inFlight -= 1;
      this.touch();
    }
  }

  private forward(
    upstream: UpstreamServer,
    request: http.IncomingMessage,
    body: Buffer,
    response: http.ServerResponse
  ): Promise<void> {
    return new Promise((resolve) => {
      const target = new URL(request.url ?? "/", upstream.baseUrl);
      const headers = { ...request.headers };
      delete headers.host;
      delete headers["content-length"];
      const proxied = http.request(
        target,
        {
          method: request.method,
          headers: { ...headers, "content-length": String(body.length) },
        },
        (upstreamResponse) => {
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            upstreamResponse.headers
          );
          upstreamResponse.pipe(response);
          upstreamResponse.on("end", resolve);
          upstreamResponse.on("error", () => {
            response.end();
            resolve();
          });
        }
      );
      proxied.on("error", (error) => {
        if (!response.headersSent) fail(response, 502, error.message);
        else response.end();
        resolve();
      });
      // The client going away mid-stream: stop generating for nobody.
      response.on("close", () => proxied.destroy());
      proxied.end(body);
    });
  }
}
