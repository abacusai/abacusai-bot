import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
/**
 * What each Abacus request billed, as the server reports it on the stream's
 * final usage chunk (`usage.compute_points_used`, 100 to a credit), kept on
 * the request's assistant message and summed per turn. Pi drops usage keys it
 * does not know, so the Abacus provider's stream reads them off the bytes.
 */
import { streamSimple as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";

const POINTS_PER_CREDIT = 100;

type BilledListener = (credits: number) => void;
const billedListeners = new Set<BilledListener>();

/**
 * Every Abacus request this process makes, as it ends, with what it billed:
 * the turn's own calls, its sub-agents' and its memory upkeep alike. The
 * spend governor sums them into the turn. Returns the unsubscribe.
 */
export const onBilledCredits = (listener: BilledListener): (() => void) => {
  billedListeners.add(listener);
  return () => billedListeners.delete(listener);
};

/** One Abacus request ended having billed `credits`. */
export const noteBilledCredits = (credits: number): void => {
  for (const listener of billedListeners) listener(credits);
};

/** An assistant message from an Abacus request, with what the server said it billed. */
export type MeteredMessage = AssistantMessage & { abacusCredits?: number };

/**
 * A turn's Abacus credits: absent when no request went to Abacus, null when
 * one did and its charge is unknown (an older server, a stream cut short),
 * so a caller shows nothing rather than a partial sum.
 */
export type TurnCredits = number | null | undefined;

/** The billed compute points one `data:` line of the stream carries, if any. */
export const billedPointsOf = (line: string): number | null => {
  if (!line.startsWith("data:") || !line.includes("compute_points_used"))
    return null;
  try {
    const usage = (
      JSON.parse(line.slice(5)) as {
        usage?: { compute_points_used?: unknown };
      } | null
    )?.usage;
    const points = usage?.compute_points_used;
    return typeof points === "number" && Number.isFinite(points) && points >= 0
      ? points
      : null;
  } catch {
    return null;
  }
};

/**
 * `fetch`, with every response body passed through unchanged while its SSE
 * lines are read for the billed points. The read runs inside the transform,
 * so the points are known before pi sees the bytes that end the stream.
 */
const meteredFetch =
  (onPoints: (points: number) => void): typeof fetch =>
  async (input, init) => {
    const response = await fetch(input, init);
    if (response.body == null) return response;
    const decoder = new TextDecoder();
    let pending = "";
    const scan = (text: string) => {
      const lines = (pending + text).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const points = billedPointsOf(line.trim());
        if (points != null) onPoints(points);
      }
    };
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          scan(decoder.decode(chunk, { stream: true }));
          controller.enqueue(chunk);
        },
        flush() {
          scan(`${decoder.decode()}\n`);
        },
      })
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

/**
 * The Abacus provider's stream: pi's chat-completions stream, its request's
 * billed credits stamped on the message it ends with.
 */
export const abacusStreamSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
): AssistantMessageEventStream => {
  let points: number | null = null;
  const inner = streamCompletions(
    model as Model<"openai-completions">,
    context,
    {
      ...options,
      fetch: meteredFetch((value) => {
        points = value;
      }),
    }
  );
  const outer = createAssistantMessageEventStream();
  void (async () => {
    for await (const event of inner) {
      const ended =
        event.type === "done"
          ? event.message
          : event.type === "error"
            ? event.error
            : null;
      if (ended != null && points != null) {
        const credits = points / POINTS_PER_CREDIT;
        (ended as MeteredMessage).abacusCredits = credits;
        noteBilledCredits(credits);
      }
      outer.push(event);
    }
    outer.end();
  })();
  return outer;
};

/** Two parts of one turn, added: unknown wins over a sum, a sum over nothing. */
export const addCredits = (a: TurnCredits, b: TurnCredits): TurnCredits => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (a === null || b === null) return null;
  return a + b;
};

type MessageLike = {
  role?: string;
  provider?: string;
  stopReason?: string;
  content?: unknown;
  abacusCredits?: number;
};

/**
 * The Abacus credits of one run's messages. A request that failed before it
 * streamed anything was never billed; any other without a charge makes the
 * whole turn unknown.
 */
export const turnCredits = (
  messages: ReadonlyArray<MessageLike>
): TurnCredits => {
  let total: TurnCredits;
  for (const message of messages) {
    if (message.role !== "assistant" || message.provider !== "abacus") continue;
    if (typeof message.abacusCredits === "number") {
      total = addCredits(total, message.abacusCredits);
      continue;
    }
    const empty =
      (message.stopReason === "error" || message.stopReason === "aborted") &&
      (!Array.isArray(message.content) || message.content.length === 0);
    if (!empty) return null;
  }
  return total;
};
