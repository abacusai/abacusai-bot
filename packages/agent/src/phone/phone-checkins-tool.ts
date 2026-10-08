/**
 * `checkins`: the user's say over the short texts the app may send them here
 * about their own unfinished tasks (something waiting on them, something
 * due, a link not finished). The server owns the setting and sends those
 * texts; this tool only reads and changes it, on the account's channels
 * endpoint with the Abacus key the agent already runs on.
 */
import { abacusV1BaseUrl } from "../abacus-endpoint.js";
import {
  isTimeZone,
  languageCode,
  writePhoneLanguage,
  writePhoneZone,
} from "./phone-nudges.js";
import {
  type PhoneToolDefinition,
  stringParam,
  toolText,
} from "./phone-tool.js";

export const PHONE_CHECKINS_TOOL_NAME = "checkins";

const OPS = [
  "off",
  "on",
  "status",
  "quiet",
  "limit",
  "timezone",
  "language",
] as const;

type CheckinsOp = (typeof OPS)[number];

const CALL_TIMEOUT_MS = 20_000;
const QUIET_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const MAX_LIMIT = 10;
/** How a server without the action refuses it. */
const UNKNOWN_ACTION_RE = /action must be one of/i;

/** What the server said: its settings, a refusal with its reason, or nothing (an older server, or none reached). */
export type CheckinsAnswer =
  | { kind: "settings"; settings: Record<string, unknown> }
  | { kind: "refused"; reason: string }
  | { kind: "unavailable" };

export type CheckinsCall = (
  body: Record<string, unknown>
) => Promise<CheckinsAnswer>;

export function channelsCheckinsCall(
  baseUrl: () => string = () => abacusV1BaseUrl()
): CheckinsCall {
  return async (body) => {
    const key = (process.env.ABACUS_API_KEY ?? "").trim();
    if (key.length === 0) return { kind: "unavailable" };
    try {
      const response = await fetch(`${baseUrl()}/abacusaibot_channels`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: PHONE_CHECKINS_TOOL_NAME, ...body }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      const payload: unknown = await response.json().catch(() => null);
      const fields =
        payload != null && typeof payload === "object"
          ? (payload as Record<string, unknown>)
          : {};
      if (response.ok && fields.ok === true)
        return { kind: "settings", settings: fields };
      const reason = typeof fields.error === "string" ? fields.error : "";
      if (response.status >= 500 || UNKNOWN_ACTION_RE.test(reason))
        return { kind: "unavailable" };
      return {
        kind: "refused",
        reason:
          fields.needs_confirmation === true
            ? "the server wants the user's confirmation"
            : reason.length > 0
              ? reason
              : `status ${response.status}`,
      };
    } catch {
      return { kind: "unavailable" };
    }
  };
}

/** The setting as the server reports it, one fact a line. */
function describeSettings(result: Record<string, unknown>): string {
  const lines: string[] = [];
  if (typeof result.enabled === "boolean")
    lines.push(`Check-ins: ${result.enabled ? "on" : "off"}.`);
  if (typeof result.quiet === "string")
    lines.push(`Quiet hours: ${result.quiet}.`);
  if (typeof result.limit === "number")
    lines.push(
      `At most ${result.limit} check-ins between the user's messages.`
    );
  else if ("limit" in result) lines.push("Check-in limit: the plan's own.");
  lines.push(
    typeof result.timezone === "string"
      ? `Timezone: ${result.timezone}.`
      : "Timezone: not known."
  );
  lines.push(
    typeof result.language === "string"
      ? `Language: ${result.language}.`
      : "Language: not set."
  );
  return lines.join("\n");
}

const UNAVAILABLE =
  "Check-ins are not available from here right now; nothing was changed. If the user asked, tell them so plainly.";

/** The fields one op sends, or why it cannot. A null limit, timezone or language resets it. */
function opBody(
  op: CheckinsOp,
  params: Record<string, unknown>
): Record<string, unknown> | string {
  switch (op) {
    case "status":
      return { op };
    case "on":
      return { op, enabled: true };
    case "off":
      // The user's clear word, never the model's guess: "stop" may mean the task.
      return params.confirmed === true
        ? { op, enabled: false, confirmed: true }
        : 'Turning check-ins off needs "confirmed": true, set only after the user clearly said they want no check-ins (not just to stop the current task). If that is not clear, ask them which they mean.';
    case "quiet": {
      const quiet = stringParam(params.quiet).replace(/\s+/g, "");
      return QUIET_RE.test(quiet)
        ? { op, quiet }
        : 'quiet must be local hours as "HH:MM-HH:MM", e.g. "21:00-09:00".';
    }
    case "limit": {
      const limit = params.limit;
      if (limit === null) return { op, limit: null };
      return typeof limit === "number" &&
        Number.isInteger(limit) &&
        limit >= 0 &&
        limit <= MAX_LIMIT
        ? { op, limit }
        : `limit must be a whole number from 0 to ${MAX_LIMIT}, or null for the plan's own.`;
    }
    case "timezone": {
      if (params.timezone === null) return { op, timezone: null };
      const timezone = stringParam(params.timezone).trim();
      return isTimeZone(timezone)
        ? { op, timezone }
        : 'timezone must be an IANA name like "Asia/Kolkata", or null to forget it.';
    }
    case "language": {
      if (params.language === null) return { op, language: null };
      const language = languageCode(stringParam(params.language));
      return language != null
        ? { op, language }
        : 'language must be a language code like "es" or "pt-BR".';
    }
  }
}

export function buildPhoneCheckinsTool(
  home: string,
  call: CheckinsCall = channelsCheckinsCall()
): PhoneToolDefinition {
  return {
    name: PHONE_CHECKINS_TOOL_NAME,
    label: PHONE_CHECKINS_TOOL_NAME,
    description: [
      "The user's check-ins: short texts the app may send them in this chat",
      "about their own unfinished tasks (something waiting on them, something",
      "due, a link they did not finish). You never send those yourself.",
      "",
      'op "status" says how they are set. "off" stops them and needs',
      '"confirmed": true, only after the user clearly asked for no check-ins;',
      'if "stop" could mean the task you are doing, ask which they mean first.',
      '"on" turns them back on. "quiet" sets local quiet hours ("21:00-09:00").',
      '"limit" sets how many may go between the user\'s messages (0 to 10).',
      '"timezone" sets the user\'s IANA zone. "language" sets the code of the',
      'language they write in ("es", "pt-BR"). null for limit, timezone or',
      "language resets it.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: [...OPS] },
        confirmed: {
          type: "boolean",
          description: 'For "off": the user clearly asked for no check-ins.',
        },
        quiet: { type: "string", description: 'For "quiet": "HH:MM-HH:MM".' },
        limit: {
          type: ["integer", "null"],
          description: 'For "limit": 0 to 10, or null for the plan\'s own.',
        },
        timezone: {
          type: ["string", "null"],
          description: 'For "timezone": IANA name, e.g. "Europe/Madrid".',
        },
        language: {
          type: ["string", "null"],
          description: 'For "language": a code, e.g. "es".',
        },
      },
      required: ["op"],
    },
    execute: async (_toolCallId, params) => {
      const op = stringParam(params.op) as CheckinsOp;
      if (!OPS.includes(op))
        return toolText(`op must be one of ${OPS.join(", ")}.`, true);
      const body = opBody(op, params);
      if (typeof body === "string") return toolText(body, true);
      const answer = await call(body);
      if (answer.kind === "unavailable")
        return toolText(UNAVAILABLE, op !== "status");
      if (answer.kind === "refused")
        return toolText(
          `Not changed: ${answer.reason}. Nothing was changed.`,
          true
        );
      // Kept here only as the server took it: the agenda carries the language, the clock the zone.
      const { settings } = answer;
      if (typeof settings.language === "string" || settings.language === null)
        writePhoneLanguage(home, settings.language);
      if (
        op === "timezone" &&
        (typeof settings.timezone === "string" || settings.timezone === null)
      )
        writePhoneZone(home, settings.timezone);
      return toolText(describeSettings(settings));
    },
  };
}
