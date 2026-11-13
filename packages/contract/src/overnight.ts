/**
 * Tomorrow's result: after a result, the next step may offer one piece of
 * that work done overnight. On the user's yes the model books it with
 * `overnight_task`, which makes a one-time routine from the chat's plan. It
 * runs once the user has left that chat, reports into it, and is brought up
 * at the ready hour. Main and the renderer read the same times from here.
 */

export const OVERNIGHT_TOOL = "overnight_task";

/** `overnight_task`, under its MCP server's prefix or bare. */
export const isOvernightTool = (name: string): boolean =>
  name === OVERNIGHT_TOOL || name.endsWith(`_${OVERNIGHT_TOOL}`);

/** The hour, local time, the result is brought up. */
export const OVERNIGHT_READY_HOUR = 9;

/** A booking closer to the ready hour than this waits for the next one. */
const OVERNIGHT_MIN_LEAD_MS = 3 * 60 * 60 * 1000;

/** The run starts once the user has left the chat this long; each visit moves it on. */
export const OVERNIGHT_QUIET_MS = 45 * 60 * 1000;

/** The run's prompt opens with this and the booked chat's id, so a transcript reader knows it. */
export const OVERNIGHT_ENVELOPE = "[overnight] ";

/** A free account with fewer credits left than this is not offered one: the run spends them. */
export const OVERNIGHT_MIN_CREDITS_LEFT = 300;

/** What a booking's result says first, with its ready time, for the model and the card. */
export const OVERNIGHT_BOOKED_PREFIX = "Booked for ";

/** The first ready hour at least OVERNIGHT_MIN_LEAD_MS after `bookedAt`, local time. */
export const overnightReadyAt = (bookedAt: number): number => {
  const ready = new Date(bookedAt);
  ready.setHours(OVERNIGHT_READY_HOUR, 0, 0, 0);
  while (ready.getTime() - bookedAt < OVERNIGHT_MIN_LEAD_MS)
    ready.setDate(ready.getDate() + 1);
  return ready.getTime();
};

/** When the run starts: once the user has been away from the chat for OVERNIGHT_QUIET_MS. */
export const overnightStartAt = (lastActive: number): number =>
  lastActive + OVERNIGHT_QUIET_MS;

/** `at` as ISO 8601 with the local offset, as the booking's result says it. */
export const localIso = (at: number): string => {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:00` +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  );
};

/** The ready time a booking's result names, or null for any other text (a refusal). */
export const bookedReadyAt = (text: string): number | null => {
  if (!text.startsWith(OVERNIGHT_BOOKED_PREFIX)) return null;
  const at = Date.parse(
    text.slice(OVERNIGHT_BOOKED_PREFIX.length).split(/[\s.]/, 1)[0] ?? ""
  );
  return Number.isNaN(at) ? null : at;
};
