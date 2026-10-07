/**
 * The checkout's tools on the browser server:
 * - `browser_pause`, the browser sub-agent's structured stop;
 * - `browser_checkout`, the agent runtime's own handle on the session's
 *   checkout (start, resume, hold, finish). The runtime calls it; no model
 *   is offered it (the agent leaves it out of every tool list);
 * - `browser_traveler_fill`, which types a saved passport number into a
 *   field without the model ever seeing it.
 * Their results end with one `checkout-state:` line of JSON that the agent
 * reads; everything in it that came from a page is sanitized here first.
 */
import type { McpToolListing } from "../mcp/mcp-http-server";
import {
  type CheckoutPause,
  type CheckoutStage,
  PAUSE_NEEDS,
  type PauseNeed,
} from "./checkout-run";

export const BROWSER_PAUSE_TOOL = "browser_pause";
export const BROWSER_CHECKOUT_TOOL = "browser_checkout";
export const TRAVELER_FILL_TOOL = "browser_traveler_fill";

/** Keep in step with CHECKOUT_STATE_PREFIX in packages/agent/src/checkout-run.ts. */
export const CHECKOUT_STATE_PREFIX = "checkout-state: ";

/** The stops where the page is the question: they carry a screenshot. */
export const SCREENSHOT_NEEDS: ReadonlySet<PauseNeed> = new Set([
  "payment",
  "captcha",
  "choose",
]);

/** The fields `browser_traveler_fill` types; only numbers the model must not see. */
export const TRAVELER_FILL_FIELDS: readonly string[] = ["passport_number"];

const MAX_SUMMARY_CHARS = 400;
const MAX_MERCHANT_CHARS = 80;
const MAX_FIELDS = 15;

/**
 * Text that came from a page, made safe to quote to a model: one line, no
 * quotes, brackets or backticks that could close a quoted argument or open
 * an instruction, no control characters, bounded.
 */
export function pageText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/["'`“”‘’«»<>{}[\]\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export const CHECKOUT_TOOL_LISTINGS: McpToolListing[] = [
  {
    name: BROWSER_PAUSE_TOOL,
    description: [
      "Stop at a step only the user can do, and say exactly what it needs. This ends your run;",
      "the page stays as it is and you are resumed on it once the user has done their part.",
      "",
      "need:",
      "- \"details\": the form wants the traveler's or buyer's details your task did not give;",
      '  list each field the form asks for in fields (e.g. ["full name as on ID", "date of birth"]).',
      '- "login": the site wants the user signed in and your task has no vault item_id for it.',
      '- "code": the site or the bank sent the user a one-time code.',
      '- "payment": you are on the page with the card form and the final total, before any card',
      "  is entered. Give total_ref (the ref of the element showing the order total with its",
      "  currency), merchant, and cvv_required if the page asks for a CVV. The browser reads the",
      "  total itself.",
      '- "captcha": a CAPTCHA blocks the page.',
      '- "choose": the user must pick (a flight, a seat, a fare) and the task did not say which.',
      "",
      "A screenshot of the page (secret fields hidden) is taken for payment, captcha and choose.",
      "Call it alone, never beside other tools. Never put a password, card number, CVV or code",
      "in any field of this call.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        need: { type: "string", enum: [...PAUSE_NEEDS] },
        summary: {
          type: "string",
          description:
            "One or two sentences: where you are and what the user must do or decide.",
        },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "For details: each field the form asks for.",
        },
        total_ref: {
          type: "string",
          description: "For payment: the ref of the element showing the total.",
        },
        currency: {
          type: "string",
          description:
            'For payment, only when the total\'s sign is shared ("$"): its ISO code, e.g. "USD".',
        },
        merchant: {
          type: "string",
          description: "For payment: who is paid, as the page names them.",
        },
        cvv_required: {
          type: "boolean",
          description: "For payment: whether the page asks for a CVV.",
        },
      },
      required: ["need", "summary"],
    },
  },
  {
    name: BROWSER_CHECKOUT_TOOL,
    description:
      "The agent runtime's handle on this session's checkout. Not for models.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "resume", "hold", "finish", "abandon", "state"],
        },
        summary: { type: "string" },
        end: { type: "string" },
        token: { type: "string" },
        answered: { type: "boolean" },
      },
      required: ["action"],
    },
  },
  {
    name: TRAVELER_FILL_TOOL,
    description: [
      "Type a saved traveler's passport number into a field, without you ever seeing it. Give",
      "the traveler id your task names (e.g. t1) and the field's ref from a snapshot. Other",
      "traveler details (name, date of birth, expiry) are in your task: fill those yourself.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        traveler_id: { type: "string", description: "e.g. t1" },
        field: { type: "string", enum: [...TRAVELER_FILL_FIELDS] },
        ref: { type: "string", description: "The field to type into" },
      },
      required: ["traveler_id", "field", "ref"],
    },
  },
];

/** A pause call's input, before the browser adds what it reads itself. */
export interface PauseInput {
  need: PauseNeed;
  summary: string;
  fields: string[];
  totalRef: string | null;
  currency: string | null;
  merchant: string | null;
  cvvRequired: boolean;
}

/** A `browser_pause` call's input, or why it is refused. */
export function parsePause(
  args: Record<string, unknown>
): { ok: true; input: PauseInput } | { ok: false; reason: string } {
  const need = args.need;
  if (!PAUSE_NEEDS.includes(need as PauseNeed))
    return { ok: false, reason: `need is one of: ${PAUSE_NEEDS.join(", ")}.` };
  const summary = pageText(args.summary, MAX_SUMMARY_CHARS);
  if (summary.length === 0)
    return {
      ok: false,
      reason: "summary is required: where you are and what the user must do.",
    };
  const fields = Array.isArray(args.fields)
    ? args.fields
        .map((field) => pageText(field, 60))
        .filter((field) => field.length > 0)
        .slice(0, MAX_FIELDS)
    : [];
  if (need === "details" && fields.length === 0)
    return {
      ok: false,
      reason:
        'A details stop lists the fields the form asks for, e.g. ["full name as on ID", "date of birth"].',
    };
  const merchant = pageText(args.merchant, MAX_MERCHANT_CHARS);
  const totalRef =
    typeof args.total_ref === "string" && args.total_ref.trim().length > 0
      ? args.total_ref.trim()
      : null;
  const currency =
    typeof args.currency === "string" &&
    /^[A-Za-z]{3}$/.test(args.currency.trim())
      ? args.currency.trim().toUpperCase()
      : null;
  if (need === "payment") {
    if (totalRef == null)
      return {
        ok: false,
        reason:
          "A payment stop names the total: total_ref, the ref of the element showing the order total with its currency.",
      };
    if (merchant.length === 0)
      return { ok: false, reason: "Name the merchant the checkout shows." };
  }
  return {
    ok: true,
    input: {
      need: need as PauseNeed,
      summary,
      fields,
      totalRef,
      currency,
      merchant: merchant.length > 0 ? merchant : null,
      cvvRequired: need === "payment" && args.cvv_required === true,
    },
  };
}

/** The checkout as the agent reads it from a result's last line. */
export interface CheckoutStateLine {
  stage: CheckoutStage;
  paused: CheckoutPause | null;
  /** On a resume: whether the user's approval for the paused total is live. */
  approved?: boolean;
}

export const checkoutStateLine = (state: CheckoutStateLine): string =>
  `${CHECKOUT_STATE_PREFIX}${JSON.stringify(state)}`;
