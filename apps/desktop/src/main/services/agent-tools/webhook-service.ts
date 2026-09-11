/**
 * A local HTTP listener that fires a job on `POST /hooks/<token>`. Loopback
 * only: the token is the whole authorization, so the listener must not be
 * reachable from anywhere it could be guessed at leisure. The capped body
 * travels to the run as the payload; a fixed port so URLs survive restarts.
 */
import http from "http";

import { jobForWebhookToken } from "./cron-store";

export const WEBHOOK_DEFAULT_PORT = 8642;
/** Payloads are context for a prompt, not file transfer. */
export const MAX_WEBHOOK_BODY = 16 * 1024;

type RunJob = (
  jobId: string,
  trigger: "webhook",
  payload: string | null
) => Promise<void>;

export class WebhookService {
  private server: http.Server | null = null;
  private listeningPort: number | null = null;

  constructor(private readonly runJob: RunJob) {}

  port(): number | null {
    return this.listeningPort;
  }

  async start(): Promise<void> {
    if (this.server != null) return;

    const server = http.createServer((req, res) => this.handle(req, res));
    this.server = server;

    const listen = (port: number): Promise<number> =>
      new Promise((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException): void => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = (): void => {
          server.removeListener("error", onError);
          const address = server.address();
          resolve(
            typeof address === "object" && address != null ? address.port : port
          );
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });

    try {
      this.listeningPort = await listen(WEBHOOK_DEFAULT_PORT);
    } catch {
      // The fixed port is taken; an ephemeral one works but will not survive
      // a restart.
      this.listeningPort = await listen(0);
    }
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.listeningPort = null;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const match = /^\/hooks\/([0-9a-f]+)$/.exec(
      (req.url ?? "").split("?")[0] ?? ""
    );

    if (match == null) {
      res.writeHead(404).end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }

    const token = match[1];
    let body = "";
    let overflowed = false;

    req.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      body += chunk.toString("utf8");
      if (body.length > MAX_WEBHOOK_BODY) {
        // Truncated rather than rejected: the fire is the signal.
        body = body.slice(0, MAX_WEBHOOK_BODY);
        overflowed = true;
      }
    });

    req.on("end", () => {
      const job = jobForWebhookToken(token);

      // Unknown and paused answer identically, so a guesser learns nothing.
      if (job == null || !job.enabled) {
        res.writeHead(404).end();
        return;
      }

      const payload = body.trim().length === 0 ? null : body.trim();

      // 202 before the run: the caller asked for a fire, not the result.
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));

      void this.runJob(job.id, "webhook", payload).catch((err: unknown) => {
        console.error("[webhooks] run failed:", err);
      });
    });
  }
}
