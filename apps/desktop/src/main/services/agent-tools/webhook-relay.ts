/**
 * The relay half of webhooks: the platform lends each hook a public URL and
 * queues deliveries, and this poller drains them into the matching routine.
 * Events carry the routine's local token, so deleting a job makes its
 * deliveries dead letters. Registration is idempotent and re-run on start.
 */
import { credentialFor } from "../config/settings";
import { abacusRoutellmV1 } from "../providers/abacus-host";
import { jobForWebhookToken, listJobs } from "./cron-store";

/** Queue latency a sender sees; matches the scheduler's own granularity. */
const POLL_INTERVAL_MS = 20_000;
const REQUEST_TIMEOUT_MS = 15_000;

type RunJob = (
  jobId: string,
  trigger: "webhook",
  payload: string | null
) => Promise<void>;

/** Fired when a registration lands, so the panel can show the public URL. */
type OnRegistered = () => void;

interface RelayEvent {
  token?: string;
  body?: string;
  truncated?: boolean;
}

export class WebhookRelay {
  private pollTimer: NodeJS.Timeout | null = null;
  /** Local webhook token -> public relay URL, filled as registrations land. */
  private readonly publicUrls = new Map<string, string>();
  private registering = false;

  constructor(
    private readonly runJob: RunJob,
    private readonly onRegistered: OnRegistered = () => {}
  ) {}

  start(): void {
    if (this.pollTimer != null) return;
    this.pollTimer = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
    // Unref'd so a pending tick cannot hold the process open at quit.
    this.pollTimer.unref?.();
    // First tick immediately, so an overnight queue does not wait an interval.
    void this.tick();
  }

  stop(): void {
    if (this.pollTimer == null) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** Register-and-drain now, so a new hook's URL exists right after Create. */
  refreshNow(): void {
    void this.tick();
  }

  /** Whether a public URL is coming at all (signed in). */
  canRegister(): boolean {
    return this.apiKey() != null;
  }

  /** The public URL for a local token, or null until registration lands. */
  publicUrlFor(localToken: string | null): string | null {
    if (localToken == null) return null;
    return this.publicUrls.get(localToken) ?? null;
  }

  private apiKey(): string | null {
    const key = credentialFor("ABACUS_API_KEY");
    return key.length > 0 ? key : null;
  }

  private webhookTokens(): string[] {
    return listJobs()
      .filter((job) => job.enabled && job.webhookToken != null)
      .map((job) => job.webhookToken as string);
  }

  private async tick(): Promise<void> {
    const key = this.apiKey();
    if (key == null) return;
    const tokens = this.webhookTokens();
    if (tokens.length === 0) return;

    try {
      await this.registerMissing(key, tokens);
      await this.drain(key);
    } catch (err) {
      // Offline is ordinary for a laptop; the next tick retries everything.
      console.warn(
        "[webhook-relay] tick failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  private async registerMissing(key: string, tokens: string[]): Promise<void> {
    if (this.registering) return;
    this.registering = true;
    let landed = false;
    try {
      for (const token of tokens) {
        if (this.publicUrls.has(token)) continue;
        const response = await this.post(key, "/abacusaibot_hook_url", {
          token,
        });
        const path = (response as { path?: string }).path;
        if (typeof path === "string" && path.length > 0) {
          // The platform returns only the path; the base is the host this app
          // already talks to, so the two cannot disagree.
          this.publicUrls.set(
            token,
            `${abacusRoutellmV1().replace(/\/v1$/, "")}${path}`
          );
          landed = true;
        }
      }
    } finally {
      this.registering = false;
      // Announce after the batch, not per token: the panel re-reads the list.
      if (landed) this.onRegistered();
    }
  }

  private async drain(key: string): Promise<void> {
    // Keep draining while full pages come back, so a burst clears in one tick.
    for (let page = 0; page < 5; page++) {
      const response = (await this.post(
        key,
        "/abacusaibot_hook_events",
        {}
      )) as {
        events?: RelayEvent[];
        dropped?: number;
      };
      if (typeof response.dropped === "number" && response.dropped > 0) {
        // The queue capped out; silence here would look like "nothing fired".
        console.warn(
          `[webhook-relay] the platform dropped ${response.dropped} webhook deliveries (queue full)`
        );
      }
      const events = Array.isArray(response.events) ? response.events : [];
      for (const event of events) {
        this.dispatch(event);
      }
      if (events.length < 50) return;
    }
  }

  private dispatch(event: RelayEvent): void {
    const token = event.token;
    if (typeof token !== "string" || token.length === 0) return;
    const job = jobForWebhookToken(token);
    // Unknown token: the job was deleted or its token cleared. Dropping the
    // event is the revocation working.
    if (job == null || !job.enabled) return;

    let payload = (event.body ?? "").trim();
    if (payload.length > 0 && event.truncated === true) {
      payload += "\n[payload truncated by the relay at 64KB]";
    }
    void this.runJob(
      job.id,
      "webhook",
      payload.length > 0 ? payload : null
    ).catch((err: unknown) => {
      console.error("[webhook-relay] run failed:", err);
    });
  }

  private async post(
    key: string,
    endpoint: string,
    body: object
  ): Promise<unknown> {
    const response = await fetch(`${abacusRoutellmV1()}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error(`${endpoint} answered ${response.status}`);
    return response.json();
  }
}
