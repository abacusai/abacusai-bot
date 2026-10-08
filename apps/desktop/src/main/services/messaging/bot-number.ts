import { mediaFields, type ResolvedMedia } from "@abacus-ai/agent/send-media";

/**
 * The user's WhatsApp link to AbacusAI Bot's own number, as the hosted
 * computer's app chats see it: whether the server has one (`status`), and a
 * message to the user there (`notify`), which the server sends through its
 * own gate or refuses with a reason. Host-only: the desktop never attaches
 * one, so its WhatsApp stays its own pairing.
 */

/** `/v1/abacusaibot_channels`, as the host calls it with the user's key. */
export type BotNumberCall = <T>(
  body: Record<string, unknown>,
  timeoutMs: number
) => Promise<T>;

/** What a notify did: sent, or why not, in words the model can pass on. */
export type BotNumberOutcome =
  | { sent: true }
  | { sent: false; reason: string; unconfirmed?: boolean };

/** How the link reads in a session's "what you are connected to" note. */
export const BOT_NUMBER_FOR_AGENT =
  "whatsapp (AbacusAI Bot's own number, which the user linked: send_to_whatsapp messages the user there, and only them)";

/** Asked again after this long; a caller that must see a change now waits less. */
const STATUS_TTL_MS = 30_000;
const FRESH_TTL_MS = 4_000;
const STATUS_TIMEOUT_MS = 10_000;
const NOTIFY_TIMEOUT_MS = 20_000;
/** A document of up to 16 MB goes up in the call. */
const DOCUMENT_TIMEOUT_MS = 90_000;

interface StatusReply {
  whatsapp_bot?: { status?: string } | null;
}

export class BotNumber {
  private known = false;
  private readAt = Number.NEGATIVE_INFINITY;
  private reading: Promise<boolean> | null = null;

  constructor(
    private readonly deps: {
      call: BotNumberCall;
      /** The link appeared or went: sessions are told and re-list their tools. */
      onChange: () => void;
      now?: () => number;
    }
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The last answer, without asking. */
  linked(): boolean {
    return this.known;
  }

  /** The server's answer when the last is stale; one that cannot be read keeps the last. */
  read(options: { fresh?: boolean } = {}): Promise<boolean> {
    const ttl = options.fresh === true ? FRESH_TTL_MS : STATUS_TTL_MS;
    if (this.now() - this.readAt < ttl) return Promise.resolve(this.known);
    this.reading ??= this.ask().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private async ask(): Promise<boolean> {
    try {
      const reply = await this.deps.call<StatusReply>(
        { action: "status" },
        STATUS_TIMEOUT_MS
      );
      this.set(reply.whatsapp_bot?.status === "linked");
    } catch (error) {
      console.warn("[bot-number] status failed:", describe(error));
    } finally {
      this.readAt = this.now();
    }
    return this.known;
  }

  private set(linked: boolean): void {
    if (linked === this.known) return;
    this.known = linked;
    this.deps.onChange();
  }

  /** `text` to the user's WhatsApp, as `media`'s caption when there is media. */
  async notify(
    text: string,
    media: Extract<ResolvedMedia, { ok: true }> | null
  ): Promise<BotNumberOutcome> {
    const document = media?.kind === "document";
    try {
      const reply = await this.deps.call<{ ok?: boolean; error?: string }>(
        {
          action: "notify",
          ...(text.length > 0 ? { text } : {}),
          ...(media != null ? mediaFields(media) : {}),
        },
        document ? DOCUMENT_TIMEOUT_MS : NOTIFY_TIMEOUT_MS
      );
      if (reply.ok === true) return { sent: true };
      // A refusal may mean the link went: the next read asks again.
      this.readAt = Number.NEGATIVE_INFINITY;
      return { sent: false, reason: reply.error ?? "it was refused" };
    } catch (error) {
      console.warn("[bot-number] notify failed:", describe(error));
      if (error instanceof Error && error.name === "TimeoutError")
        return {
          sent: false,
          unconfirmed: true,
          reason: "WhatsApp did not confirm it in time; it may still arrive",
        };
      return { sent: false, reason: "AbacusAI Bot could not be reached" };
    }
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
