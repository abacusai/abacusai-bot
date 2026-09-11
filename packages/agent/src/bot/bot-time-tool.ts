/**
 * `current_time` — the bot's clock. The bot loop has no shell (no `date`),
 * and a model with no clock asks the user for something every machine knows.
 * An optional IANA timezone covers "what time is it for the client in Berlin".
 */
interface PiToolDefinitionLike {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
    isError?: boolean;
  }>;
}

export const BOT_TIME_TOOL_NAME = "current_time";

const text = (body: string, isError = false) => ({
  content: [{ type: "text" as const, text: body }],
  details: null,
  ...(isError ? { isError: true } : {}),
});

export const describeNow = (timezone?: string): string => {
  const zone =
    timezone != null && timezone.length > 0
      ? timezone
      : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date());

  return `${formatted} (${zone})`;
};

/**
 * IANA name, short name and the UTC offset in force right now: enough to
 * convert a calendar's UTC or a sender's zone without a tool call.
 */
export const describeTimezone = (timezone?: string): string => {
  const zone =
    timezone != null && timezone.length > 0
      ? timezone
      : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const part = (name: "short" | "longOffset"): string =>
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: name })
      .formatToParts(now)
      .find((piece) => piece.type === "timeZoneName")?.value ?? "";
  const short = part("short");
  // At zero offset Intl says a bare "GMT" with no ±hh:mm; spell the zero out.
  const raw = part("longOffset");
  const offset = /^GMT[+-]/.test(raw)
    ? raw.replace(/^GMT/, "UTC")
    : "UTC+00:00";
  return `${zone} (${short}, ${offset})`;
};

/**
 * The paragraph every system prompt carries about time. Connectors return
 * UTC or the event's own zone, so the user's zone is stated up front. The
 * zone only, never the clock: a prompt that changes every minute is a prompt
 * cache that never hits, so the time stays behind the `current_time` tool.
 */
export const timezonePrompt = (): string =>
  [
    `The user's local timezone is ${describeTimezone()}. For the current`,
    "date and time, call `current_time`.",
    "Present every time you show — calendar events, deadlines, message",
    'timestamps, "how long until" — in the user\'s local timezone, converting',
    "from the source's zone (connectors often return UTC or the event's own",
    "zone) and naming the zone once. Never show a source zone's time as if it",
    "were local, and never promise to convert later: convert now.",
  ].join(" ");

export function buildBotTimeTool(): PiToolDefinitionLike {
  return {
    name: BOT_TIME_TOOL_NAME,
    label: BOT_TIME_TOOL_NAME,
    description: [
      "The current date and time. You have no other clock: call this whenever",
      "timing matters — deadlines, schedules, how far away a meeting is —",
      "instead of asking the user or guessing.",
      "",
      'Optional "timezone" (an IANA name like "Europe/Berlin") answers what',
      "time it is somewhere else; omitted, you get the user's local time.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
          description: 'IANA timezone, e.g. "America/New_York". Optional.',
        },
      },
    },
    execute: async (_toolCallId, params) => {
      const timezone =
        typeof params.timezone === "string" ? params.timezone.trim() : "";
      try {
        return text(describeNow(timezone.length > 0 ? timezone : undefined));
      } catch {
        return text(
          `Unknown timezone "${timezone}". Use an IANA name like "Asia/Kolkata", or omit it for local time.`,
          true
        );
      }
    },
  };
}
