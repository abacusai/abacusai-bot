/**
 * What a vault fill may do, decided before any value is asked for: which
 * origin the server is told (always the live page's, never the model's),
 * whether the target frame may receive the value, and, for a card, which
 * approval it fills under and which total the page itself shows. Pure, so
 * every refusal is testable.
 */
import { WAS_PASSWORD_ATTRIBUTE } from "../browser/secret-fields";
import {
  type CardClass,
  type CardControl,
  cardPhrases,
  classifyCardControls,
} from "./card-fields";
import { onSite } from "./site";
import type { VaultField } from "./vault-client";
import type { PaymentApproval, SigninApproval } from "./vault-session";

/**
 * Payment providers whose card and code frames a checkout embeds. A card
 * number, CVV or code goes into a frame whose origin is not the page's only
 * when the frame is one of theirs (the host or a subdomain of it).
 */
export const PAYMENT_FRAME_HOSTS: readonly string[] = [
  "stripe.com",
  "adyen.com",
  "razorpay.com",
  "braintreegateway.com",
  "checkout.com",
  "paypal.com",
];

const CARD_FIELDS: ReadonlySet<VaultField> = new Set([
  "card_number",
  "cvv",
  "card_exp_month",
  "card_exp_year",
  "cardholder_name",
]);

/**
 * What `browser_vault_fill` can type: a vault field, or `card_exp`, a
 * single expiry field filled from the card's month and year.
 */
export type FillKind = VaultField | "card_exp";

export const FILL_KINDS: readonly FillKind[] = [
  "username",
  "password",
  "code",
  "card_number",
  "cvv",
  "card_exp",
  "card_exp_month",
  "card_exp_year",
  "cardholder_name",
];

/** The vault fields a fill kind is made of. */
export const fieldsOf = (kind: FillKind): VaultField[] =>
  kind === "card_exp" ? ["card_exp_month", "card_exp_year"] : [kind];

/**
 * Whether the vault said it has no such field: a server from before expiry
 * and cardholder fills. The model is then told to leave them to the user.
 */
export const fieldUnsupported = (error: string, field: VaultField): boolean =>
  error.includes(field) && /\bno vault field\b|\bhas no\b/i.test(error);

export const httpsHost = (origin: string | null): string | null => {
  if (origin == null) return null;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

const withinDomain = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

/** Whether `origin` is an https frame of one of `PAYMENT_FRAME_HOSTS`. */
export const isPaymentFrameOrigin = (origin: string | null): boolean => {
  const host = httpsHost(origin);
  return (
    host != null &&
    PAYMENT_FRAME_HOSTS.some((domain) => withinDomain(host, domain))
  );
};

/**
 * One number as a page writes it ("1,234.00", "1.234,50", "1234.5"), as a
 * plain decimal string ("1234.00", "1234.50"); null when it is not one.
 */
const normalizeNumber = (written: string): string | null => {
  let digits = written;
  const lastDot = digits.lastIndexOf(".");
  const lastComma = digits.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    // Both: the later one is the decimal point.
    const decimal = lastDot > lastComma ? "." : ",";
    const grouping = decimal === "." ? "," : ".";
    digits = digits.split(grouping).join("").replace(decimal, ".");
  } else if (lastComma >= 0) {
    // A comma alone is a decimal comma only before one or two digits at the end.
    const tail = digits.length - lastComma - 1;
    const single = digits.indexOf(",") === lastComma;
    digits =
      single && tail > 0 && tail <= 2
        ? digits.replace(",", ".")
        : digits.split(",").join("");
  } else if (lastDot >= 0 && digits.indexOf(".") !== lastDot) {
    // Several dots: grouping.
    digits = digits.split(".").join("");
  }
  return /^[0-9]{1,12}(?:\.[0-9]{1,3})?$/.test(digits) ? digits : null;
};

/** Currency signs to the ISO codes each may mean on a page. */
const CURRENCY_SIGNS: ReadonlyArray<[RegExp, readonly string[]]> = [
  [/₹|\bRs\.?(?![a-z])/i, ["INR"]],
  [/US\$/, ["USD"]],
  [/\$/, ["USD", "CAD", "AUD", "NZD", "SGD", "HKD", "MXN"]],
  [/€/, ["EUR"]],
  [/£/, ["GBP"]],
  [/¥|￥/, ["JPY", "CNY"]],
  [/₩/, ["KRW"]],
  [/₱/, ["PHP"]],
  [/฿/, ["THB"]],
  [/₫/, ["VND"]],
];

export interface PageTotal {
  /** As a plain decimal string, e.g. "1234.00". */
  amount: string;
  /** The ISO codes the text's currency may be; empty when it names none. */
  currencies: string[];
}

/**
 * The total a page element shows ("Total ₹1,234.00", "USD 99.50"): exactly
 * one number and the currencies it may be in. Null when the text holds no
 * number or more than one, so a caller never guesses which is the total.
 */
export const readPageTotal = (text: string): PageTotal | null => {
  const numbers = text.match(/[0-9][0-9.,]*/g) ?? [];
  const cleaned = numbers.map((n) => n.replace(/[.,]+$/, ""));
  if (cleaned.length !== 1) return null;
  const amount = normalizeNumber(cleaned[0]!);
  if (amount == null) return null;
  const currencies = new Set<string>();
  for (const code of text.match(/\b[A-Z]{3}\b/g) ?? []) currencies.add(code);
  for (const [sign, codes] of CURRENCY_SIGNS)
    if (sign.test(text)) for (const code of codes) currencies.add(code);
  return { amount, currencies: [...currencies] };
};

/** Whether two plain decimal amounts are the same number. */
export const sameAmount = (a: string, b: string): boolean => {
  const left = Number(a);
  const right = Number(b);
  return (
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    Math.abs(left - right) < 0.0005
  );
};

/** What the vault is told for one fill, besides the item and field. */
export interface FillRequest {
  origin: string;
  frameOrigin?: string;
  paymentApprovalId?: string;
  signinApprovalId?: string;
  amount?: string;
  currency?: string;
}

export type FillPlan =
  | {
      ok: true;
      request: FillRequest;
      /** The origin the field's own document must still have when it is typed into. */
      documentOrigin: string;
      /** The fields of the approval this fill spends (it is filled once under it); null when none. */
      uses: Set<VaultField> | null;
    }
  | {
      ok: false;
      error: string;
      /** Nothing is wrong with the page: no sign-in for this login is allowed yet. */
      awaitingApproval?: true;
    };

export interface FillContext {
  itemId: string;
  field: FillKind;
  /** The live origin of the tab's top-level page. */
  topOrigin: string | null;
  /** The live origin of the cross-origin frame the field is in; null when it is in the page. */
  frameOrigin: string | null;
  /** The field is in a cross-origin frame (whose origin may be unknown). */
  inFrame: boolean;
  /** The approval the user granted this session, if any. */
  approval: PaymentApproval | null;
  /** The sign-in the user allowed this session, if any. */
  signin: SigninApproval | null;
  /**
   * The total the page shows, as the host read it from the element the
   * model pointed at; null when none was named or it could not be read.
   */
  pageTotal: PageTotal | null;
}

const refuse = (error: string): FillPlan => ({ ok: false, error });
/** Why a login fill waits when the user has allowed no sign-in: the first thing a login fill says. */
export const NO_SIGNIN_REASON =
  'Waiting for sign-in approval: no sign-in is allowed for this login now, so nothing was filled. Stop with browser_pause need:"login"; the user allows the sign-in first.';

const awaitSignin = (error: string): FillPlan => ({
  ok: false,
  error: `Waiting for sign-in approval: ${error}`,
  awaitingApproval: true,
});

/**
 * The origin and approval a fill goes under, or why it may not happen.
 *
 * - A login's username, password or sign-in code is filled for the document
 *   the field is in (the frame's origin in a frame, else the page's), only
 *   under the sign-in the user allowed for that login on that document's
 *   site, once each; a code goes into a cross-origin frame only when it is a
 *   payment provider's.
 * - A card number or CVV goes under the top-level page's origin, on the
 *   approved site, into the page or a payment provider's frame, against the
 *   total the page shows, once each.
 * - A bank's code for the approved card goes only into the document whose
 *   live origin is the one its code request was bound to, framed or
 *   top-level, while the approval is live.
 */
export function planFill(context: FillContext): FillPlan {
  const approval = context.approval;
  if (httpsHost(context.topOrigin) == null)
    return refuse(
      "Refused: saved logins and cards are typed only into https pages, and this one is not (or its origin could not be read)."
    );
  if (context.inFrame && httpsHost(context.frameOrigin) == null)
    return refuse(
      "Refused: the frame that field is in is not an https page, or its origin could not be read."
    );
  const documentOrigin = context.inFrame
    ? context.frameOrigin!
    : context.topOrigin!;
  const frameOrigin = context.inFrame
    ? { frameOrigin: context.frameOrigin! }
    : {};

  if (context.field === "code" && approval?.item === context.itemId) {
    if (approval.codeOrigin == null)
      return refuse(
        "Refused: no bank code was asked for this payment yet. Report that the bank asks for a code; the user enters it on a vault page first."
      );
    if (documentOrigin !== approval.codeOrigin)
      return refuse(
        `Refused: the bank's code was asked for on ${approval.codeOrigin}, and this field is on ${documentOrigin}. Report where the code is asked for now.`
      );
    return {
      ok: true,
      request: {
        origin: documentOrigin,
        ...frameOrigin,
        paymentApprovalId: approval.id,
      },
      documentOrigin,
      uses: null,
    };
  }

  const fields = fieldsOf(context.field);
  const card = fields.some((field) => CARD_FIELDS.has(field));
  if (
    context.inFrame &&
    (card || context.field === "code") &&
    !isPaymentFrameOrigin(context.frameOrigin)
  )
    return refuse(
      `Refused: that field is in a frame from ${context.frameOrigin}, and a card number, CVV or code is typed ` +
        "only into the page itself or a payment provider's frame. Do not try another way; report where the field is."
    );
  if (!card) {
    const signin = context.signin;
    const host = httpsHost(documentOrigin)!;
    const pause =
      'nothing was filled. Stop with browser_pause need:"login"; the user allows the sign-in first.';
    if (signin == null)
      return { ok: false, error: NO_SIGNIN_REASON, awaitingApproval: true };
    if (signin.item !== context.itemId)
      return awaitSignin(
        `the sign-in the user allowed is for another saved login, so ${pause}`
      );
    if (!onSite(host, signin.site))
      return awaitSignin(
        `the sign-in the user allowed is for ${signin.site}, and this page is ${host}, so ${pause}`
      );
    if (signin.used.has(context.field))
      return awaitSignin(
        `the ${context.field} was already filled once under the sign-in the user allowed, so ${pause}`
      );
    return {
      ok: true,
      request: {
        origin: documentOrigin,
        ...frameOrigin,
        signinApprovalId: signin.id,
      },
      documentOrigin,
      uses: signin.used,
    };
  }

  if (approval == null)
    return refuse(
      "Refused: no payment is approved in this conversation. Stop at the checkout's review step and report the exact total, " +
        "merchant and whether a CVV is asked for; the user approves it first."
    );
  if (approval.item !== context.itemId)
    return refuse(
      `Refused: the approved payment is for card ${approval.item}, not ${context.itemId}.`
    );
  const host = httpsHost(context.topOrigin)!;
  if (!onSite(host, approval.site))
    return refuse(
      `Refused: the payment was approved for ${approval.site || "another site"}, and this page is ${host}. Report where the checkout went.`
    );
  if (fields.some((field) => approval.used.has(field)))
    return refuse(
      `Refused: the ${context.field} was already filled once under this approval. If the checkout needs it again, the user approves a new payment.`
    );
  if (context.field === "cvv" && !approval.cvvRequired)
    return refuse(
      "Refused: the payment was approved without a CVV. Report that the checkout asks for one; a new approval is needed."
    );
  const total = context.pageTotal;
  if (total == null)
    return refuse(
      "Refused: a card is filled only against the total the checkout shows. Pass total_ref, the ref of the element " +
        'showing the order total with its currency (e.g. "Total ₹1,234.00"), from a fresh snapshot.'
    );
  if (
    !sameAmount(total.amount, approval.amount) ||
    !total.currencies.includes(approval.currency)
  )
    return refuse(
      `Refused: the page shows ${total.amount}${total.currencies.length > 0 ? ` (${total.currencies.join("/")})` : " with no currency"}, ` +
        `and the user approved ${approval.amount} ${approval.currency}. Do not fill the card. Report the total the page shows; ` +
        "the user has to approve it again."
    );
  return {
    ok: true,
    request: {
      origin: context.topOrigin!,
      ...frameOrigin,
      paymentApprovalId: approval.id,
      amount: total.amount,
      currency: approval.currency,
    },
    documentOrigin,
    uses: approval.used,
  };
}

/**
 * What decides which value a field may take, read off the field: never its
 * live value, only what the page declares about it. Read twice per fill: as
 * the field was when it was first seen (before anything the agent did) and
 * as it is now; both must allow the value.
 */
export interface FieldFacts {
  tag: string;
  /** The `type` attribute, lowercase; "text" when absent. */
  type: string;
  autocomplete: string[];
  role: string;
  inputmode: string;
  enterkeyhint: string;
  pattern: string;
  /** The `maxlength` attribute; -1 when absent. */
  maxLength: number;
  /** A password field, or one marked as having been one. */
  wasPassword: boolean;
  /** The text-entry input just before or after it, in document order, is a password field. */
  adjacentPassword: boolean;
  /**
   * Words naming the field: its name, id, aria-label and placeholder (and,
   * read live, its labels), plus its name and id with separators removed
   * ("cc_exp_month" also gives "ccexpmonth").
   */
  hints: string[];
  /** What the card rule makes of it, in its document (`classifyCardControls`). */
  card: CardClass;
}

/** Words that name a field a code must never go into, though it looks like one. */
const CODE_LOOKALIKES = new Set([
  "zip",
  "zipcode",
  "postal",
  "postcode",
  "pin",
  "pincode",
]);

/** Naming text as one lowercase word, separators removed ("cc_exp-Month" → "ccexpmonth"). */
const joined = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Splits naming text into lowercase words. */
const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Input types a person types into. */
const TEXT_ENTRY = new Set([
  "text",
  "email",
  "password",
  "tel",
  "number",
  "search",
  "url",
]);

/** Expiry wording in hint words ("expiry", "expMonth", "exp date", "valid thru"). */
const EXPIRY_HINT =
  /\bexp(?:iry|iration|ires)?(?:date|month|year|mm|yy|yyyy)?\b|\bvalid ?(?:thru|through)\b|\bccexp/;
const MONTH_HINT = /month|\bmm\b/;
const YEAR_HINT = /year|\byy(?:yy)?\b/;
const CARDHOLDER_HINT =
  /\bname on card\b|\bnameoncard\b|\bcard ?holder|\bholder ?name\b|\bccname\b/;

/** Which expiry field the facts name, if any: the whole date, its month or its year. */
const expiryKind = (
  facts: FieldFacts
): "card_exp" | "card_exp_month" | "card_exp_year" | null => {
  const marked = (token: string): boolean => facts.autocomplete.includes(token);
  if (marked("cc-exp")) return "card_exp";
  if (marked("cc-exp-month")) return "card_exp_month";
  if (marked("cc-exp-year")) return "card_exp_year";
  const hints = facts.hints.join(" ");
  const month = MONTH_HINT.test(hints);
  const year = YEAR_HINT.test(hints);
  const expiry = EXPIRY_HINT.test(hints);
  // "MM/YY" on its own names an expiry; with a day it is some other date.
  if (/\bdd\b|\bday\b|birth|dob/.test(hints)) return null;
  if (month && year) return expiry || /\bmm\b/.test(hints) ? "card_exp" : null;
  if (!expiry) return null;
  if (month) return "card_exp_month";
  if (year) return "card_exp_year";
  return "card_exp";
};

/**
 * Whether `kind` may go into a field with these facts:
 * - password: a field that is or was a password field;
 * - username: a text or email input marked username or email, or right
 *   next to the password field;
 * - card_number / cvv: an input marked cc-number / cc-csc, or a plain input
 *   in a payment provider's frame;
 * - card_exp: a text input marked cc-exp, or named as the whole expiry
 *   ("MM/YY", "Expiry"); card_exp_month / card_exp_year: an input or select
 *   marked cc-exp-month / cc-exp-year, or named as the expiry's month or year;
 * - cardholder_name: a text input marked cc-name, or named as the name on
 *   the card;
 * - code: an input marked one-time-code, or a short numeric input.
 * Never a search input, and never anything but an input (or, for an
 * expiry's month or year, a select).
 */
export const fieldKindAllowed = (
  field: FillKind,
  facts: FieldFacts,
  inPaymentFrame: boolean
): boolean => {
  const select = field === "card_exp_month" || field === "card_exp_year";
  if (facts.tag !== "input" && !(select && facts.tag === "select"))
    return false;
  if (
    facts.type === "search" ||
    facts.role === "searchbox" ||
    facts.inputmode === "search" ||
    facts.enterkeyhint === "search"
  )
    return false;
  const marked = (token: string): boolean => facts.autocomplete.includes(token);
  const typed = ["text", "tel", "number"].includes(facts.type);
  switch (field) {
    case "password":
      return facts.wasPassword;
    case "username":
      return (
        (facts.type === "text" || facts.type === "email") &&
        (marked("username") || marked("email") || facts.adjacentPassword)
      );
    case "card_number":
    case "cvv":
      return (
        marked(field === "card_number" ? "cc-number" : "cc-csc") ||
        (inPaymentFrame &&
          ["text", "tel", "number", "password"].includes(facts.type))
      );
    case "card_exp":
      return facts.tag === "input" && typed && expiryKind(facts) === field;
    case "card_exp_month":
    case "card_exp_year":
      return (facts.tag === "select" || typed) && expiryKind(facts) === field;
    case "cardholder_name":
      return (
        facts.type === "text" &&
        (marked("cc-name") || CARDHOLDER_HINT.test(facts.hints.join(" ")))
      );
    case "code": {
      const numeric =
        facts.type === "number" ||
        facts.type === "tel" ||
        facts.inputmode === "numeric" ||
        facts.pattern.includes("0-9") ||
        facts.pattern.includes("\\d");
      const lookalike =
        marked("postal-code") ||
        facts.hints.some((word) => CODE_LOOKALIKES.has(word));
      return (
        marked("one-time-code") ||
        (!lookalike &&
          ["text", "tel", "number", "password"].includes(facts.type) &&
          numeric &&
          facts.maxLength >= 1 &&
          facts.maxLength <= 12)
      );
    }
    default:
      return false;
  }
};

/** A card expiry as the vault gives it: month "1"–"12", year four digits. */
export interface CardExpiry {
  month: string;
  year: string;
}

/**
 * The text an expiry kind is typed as, shaped by the field: its maxlength
 * and whether its placeholder or name asks for a four-digit year. A single
 * field takes "MM/YY" unless it says otherwise ("MM/YYYY", "MMYY", "MM / YY").
 */
export const formatExpiry = (
  kind: "card_exp" | "card_exp_month" | "card_exp_year",
  expiry: CardExpiry,
  facts: FieldFacts
): string => {
  const month = expiry.month.padStart(2, "0");
  const hints = facts.hints.join(" ");
  const max = facts.maxLength;
  if (kind === "card_exp_month") return month;
  const fourDigit = /\byyyy\b/.test(hints);
  if (kind === "card_exp_year")
    return max === 2 || (/\byy\b/.test(hints) && !fourDigit)
      ? expiry.year.slice(-2)
      : expiry.year;
  const full = fourDigit || max === 6 || (max === 7 && !/\byy\b/.test(hints));
  const year = full ? expiry.year : expiry.year.slice(-2);
  if (max === 4 || max === 6) return `${month}${year}`;
  if ((max === 7 && !full) || max === 9) return `${month} / ${year}`;
  return `${month}/${year}`;
};

/**
 * Run on a select with the candidates for one value ("05", "5", "May"):
 * picks the first option whose value or text is one of them, as a person's
 * pick would (input and change events); false when none is.
 */
export const SELECT_OPTION_FUNCTION = `function(candidates) {
  const wanted = candidates.map((item) => String(item).toLowerCase());
  const option = Array.from(this.options || []).find((item) =>
    wanted.includes(String(item.value).trim().toLowerCase()) ||
    wanted.includes(String(item.textContent || '').trim().toLowerCase()));
  if (!option) return false;
  this.value = option.value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return this.value === option.value;
}`;

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** The option texts or values a select may list a month or year as. */
export const selectCandidates = (
  kind: "card_exp_month" | "card_exp_year",
  expiry: CardExpiry
): string[] => {
  if (kind === "card_exp_year") return [expiry.year, expiry.year.slice(-2)];
  const number = Number(expiry.month);
  const name = MONTH_NAMES[number - 1] ?? "";
  return [
    String(number).padStart(2, "0"),
    String(number),
    name,
    name.slice(0, 3),
    `${String(number).padStart(2, "0")} - ${name}`,
    `${String(number).padStart(2, "0")} - ${name.slice(0, 3)}`,
  ];
};

/** A DOM node as CDP's `DOM.getDocument` returns it. */
export interface DomNode {
  backendNodeId?: number;
  nodeName?: string;
  /** A text node's text. */
  nodeValue?: string;
  attributes?: string[];
  children?: DomNode[];
}

const attributesOf = (node: DomNode): Map<string, string> => {
  const map = new Map<string, string>();
  const list = node.attributes ?? [];
  for (let index = 0; index + 1 < list.length; index += 2)
    map.set(list[index]!.toLowerCase(), list[index + 1]!);
  return map;
};

const factsOf = (
  tag: "input" | "select",
  attributes: Map<string, string>,
  adjacentPassword: boolean,
  card: CardClass
): FieldFacts => {
  const lower = (name: string): string =>
    (attributes.get(name) ?? "").toLowerCase();
  const type = tag === "select" ? "select" : lower("type") || "text";
  const maxLength = Number.parseInt(attributes.get("maxlength") ?? "", 10);
  return {
    tag,
    type,
    autocomplete: lower("autocomplete").split(/\s+/).filter(Boolean),
    role: lower("role"),
    inputmode: lower("inputmode"),
    enterkeyhint: lower("enterkeyhint"),
    pattern: lower("pattern"),
    maxLength: Number.isFinite(maxLength) ? maxLength : -1,
    wasPassword: type === "password" || attributes.has(WAS_PASSWORD_ATTRIBUTE),
    adjacentPassword,
    hints: [
      ...words(
        ["name", "id", "aria-label", "placeholder"]
          .map((name) => attributes.get(name) ?? "")
          .join(" ")
      ),
      ...["name", "id"]
        .map((name) => joined(attributes.get(name) ?? ""))
        .filter(Boolean),
    ],
    card,
  };
};

/** The naming texts the card rule reads, as the host sees them (no labels in a DOM dump). */
const NAMING_ATTRIBUTES = ["name", "id", "aria-label", "placeholder"];

/**
 * The facts of every input and select in a document, by backend node id,
 * from its DOM as CDP returns it (in document order, not into frames). One
 * pass: the card rule reads the document's controls once.
 */
export const factsFromDocument = (
  root: DomNode | undefined
): Map<number, FieldFacts> => {
  const controls: Array<{
    id: number | null;
    tag: "input" | "select";
    ancestorForm: DomNode | null;
    group: DomNode | null;
    attributes: Map<string, string>;
  }> = [];
  const formsById = new Map<string, DomNode>();
  const walk = (
    node: DomNode | undefined,
    form: DomNode | null,
    group: DomNode | null
  ): void => {
    if (node == null) return;
    const name = String(node.nodeName ?? "").toUpperCase();
    const attributes =
      name === "INPUT" ||
      name === "SELECT" ||
      name === "FORM" ||
      name === "FIELDSET" ||
      node.attributes != null
        ? attributesOf(node)
        : new Map<string, string>();
    if (name === "FORM" && attributes.has("id"))
      formsById.set(attributes.get("id")!, node);
    if (name === "INPUT" || name === "SELECT")
      controls.push({
        id: node.backendNodeId ?? null,
        tag: name === "INPUT" ? "input" : "select",
        ancestorForm: form,
        group,
        attributes,
      });
    const childForm = name === "FORM" ? node : form;
    const childGroup =
      name === "FIELDSET" ||
      (attributes.get("role") ?? "").toLowerCase() === "group"
        ? node
        : group;
    for (const child of node.children ?? []) walk(child, childForm, childGroup);
  };
  walk(root, null, null);
  /** A group's own label: its aria-label, and a fieldset's legend text. */
  const textOf = (node: DomNode): string =>
    String(node.nodeName ?? "") === "#text"
      ? (node.nodeValue ?? "")
      : (node.children ?? []).map(textOf).join(" ");
  const groupLabel = (group: DomNode | null): string[] => {
    if (group == null) return [];
    const legend = (group.children ?? []).find(
      (child) => String(child.nodeName ?? "").toUpperCase() === "LEGEND"
    );
    return [
      attributesOf(group).get("aria-label") ?? "",
      legend != null ? textOf(legend) : "",
    ];
  };
  const keys = new Map<DomNode, number>();
  const keyOf = (node: DomNode | null): number => {
    if (node == null) return 0;
    let key = keys.get(node);
    if (key == null) {
      key = keys.size + 1;
      keys.set(node, key);
    }
    return key;
  };
  // A control's form as el.form has it: its form attribute, else its ancestor.
  const cardControls: CardControl[] = controls.map((control) => {
    const formAttribute = control.attributes.get("form");
    const form =
      formAttribute != null
        ? (formsById.get(formAttribute) ?? null)
        : control.ancestorForm;
    const type =
      (control.attributes.get("type") ?? "text").toLowerCase() || "text";
    return {
      phrases: cardPhrases(
        NAMING_ATTRIBUTES.map((name) => control.attributes.get(name) ?? "")
      ),
      autocomplete: (control.attributes.get("autocomplete") ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean),
      fillable: control.tag === "select" || TEXT_ENTRY.has(type),
      form: keyOf(form),
      group: keyOf(control.group),
      groupPhrases: cardPhrases(groupLabel(control.group)),
    };
  });
  const classes = classifyCardControls(cardControls);
  const all = controls.map((control, at) => ({ ...control, at }));
  const entries = all.filter(
    (control) =>
      control.tag === "input" &&
      TEXT_ENTRY.has(
        (control.attributes.get("type") ?? "text").toLowerCase() || "text"
      )
  );
  const entryIndex = new Map(entries.map((entry, index) => [entry, index]));
  const isPassword = (index: number): boolean =>
    (entries[index]?.attributes.get("type") ?? "").toLowerCase() === "password";
  const facts = new Map<number, FieldFacts>();
  for (const input of all) {
    if (input.id == null) continue;
    const index = entryIndex.get(input) ?? -1;
    facts.set(
      field.id,
      factsOf(
        input.tag,
        input.attributes,
        index >= 0 && (isPassword(index - 1) || isPassword(index + 1)),
        classes[input.at]!
      )
    );
  }
  return facts;
};

/**
 * Whether a field is a card field by the card rule (`card-fields.ts`): a
 * card number or CVV, or a card expiry or name. The host applies it to the
 * facts it recorded at first sighting, the Pay guard's page script to the
 * same facts read live.
 */
export const cardField = (facts: FieldFacts): boolean =>
  facts.card.number || facts.card.detail != null;

/**
 * In-page `__documentFacts(root)` (every input and select of a document,
 * with its facts, in one pass) and `__factsOf(el)`: the same facts as
 * `factsFromDocument`, read live, labels included.
 */
export const FIELD_FACTS_JS = `
  const __cardPhrases = (${cardPhrases.toString()});
  const __classifyCardControls = (${classifyCardControls.toString()});
  const __TEXT_ENTRY = ${JSON.stringify([...TEXT_ENTRY])};
  const __typeOf = (el) => el.tagName === 'SELECT' ? 'select' :
    String(el.getAttribute('type') || 'text').toLowerCase() || 'text';
  const __inputs = (root) => Array.from(root.querySelectorAll('input')).filter((el) => __TEXT_ENTRY.includes(__typeOf(el)));
  const __documentFacts = (root) => {
    const controls = Array.from(root.querySelectorAll('input, select'));
    const entries = controls.filter((el) => el.tagName === 'INPUT' && __TEXT_ENTRY.includes(__typeOf(el)));
    const entryIndex = new Map(entries.map((el, index) => [el, index]));
    const isPassword = (other) => !!other && __typeOf(other) === 'password';
    const keys = new Map();
    const keyOf = (node) => {
      if (!node) return 0;
      if (!keys.has(node)) keys.set(node, keys.size + 1);
      return keys.get(node);
    };
    const groupOf = (el) => (el.closest && el.closest('fieldset, [role=group]')) || null;
    const groupLabel = (group) => {
      if (!group) return [];
      const legend = Array.from(group.children).find((child) => child.tagName === 'LEGEND');
      return [String(group.getAttribute('aria-label') || ''), legend ? String(legend.textContent || '') : ''];
    };
    const texts = (el) => [el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('aria-label'),
      el.getAttribute('placeholder'), ...Array.from(el.labels || []).map((label) => label.textContent)]
      .map((text) => String(text || ''));
    const classes = __classifyCardControls(controls.map((el) => ({
      phrases: __cardPhrases(texts(el)),
      autocomplete: String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/).filter(Boolean),
      fillable: el.tagName === 'SELECT' || __TEXT_ENTRY.includes(__typeOf(el)),
      form: keyOf(el.form),
      group: keyOf(groupOf(el)),
      groupPhrases: __cardPhrases(groupLabel(groupOf(el))),
    })));
    const facts = new Map();
    controls.forEach((el, at) => {
      const lower = (name) => String(el.getAttribute(name) || '').toLowerCase();
      const type = __typeOf(el);
      const index = entryIndex.has(el) ? entryIndex.get(el) : -1;
      const max = parseInt(el.getAttribute('maxlength') || '', 10);
      facts.set(el, {
        tag: String(el.tagName).toLowerCase(),
        type,
        autocomplete: lower('autocomplete').split(/\\s+/).filter(Boolean),
        role: lower('role'),
        inputmode: lower('inputmode'),
        enterkeyhint: lower('enterkeyhint'),
        pattern: lower('pattern'),
        maxLength: Number.isFinite(max) ? max : -1,
        wasPassword: type === 'password' || el.hasAttribute(${JSON.stringify(WAS_PASSWORD_ATTRIBUTE)}),
        adjacentPassword: index >= 0 && (isPassword(entries[index - 1]) || isPassword(entries[index + 1])),
        hints: [...texts(el).map((text) => text.toLowerCase()).join(' ').split(/[^a-z0-9]+/).filter(Boolean),
          ...[lower('name'), lower('id')].map((text) => text.replace(/[^a-z0-9]+/g, '')).filter(Boolean)],
        card: classes[at],
      });
    });
    return facts;
  };
  const __factsOf = (el) => __documentFacts(el.getRootNode()).get(el);
  const __cardField = (facts) => !!facts && (facts.card.number || facts.card.detail != null);
`;

/** Run on a field: whether it can be typed into now, and its facts. */
export const LIVE_FIELD_FUNCTION = `function() {
  ${FIELD_FACTS_JS}
  return {
    connected: this.isConnected,
    editable: !this.disabled && !this.readOnly,
    facts: __factsOf(this),
  };
}`;

/** The facts of each of a document's inputs (to find, and count, its code fields). */
export const DOCUMENT_INPUT_FACTS_SCRIPT = `(function() {
  ${FIELD_FACTS_JS}
  const facts = __documentFacts(document);
  return Array.from(document.querySelectorAll('input')).map((el) => facts.get(el));
})()`;

/**
 * Whether a code may go into a field with `facts` in a document whose
 * inputs have `documentFacts`: one marked one-time-code always; otherwise
 * only the document's one and only code-like field.
 */
export const codeFieldAllowed = (
  facts: FieldFacts,
  documentFacts: readonly FieldFacts[]
): boolean =>
  facts.autocomplete.includes("one-time-code") ||
  (fieldKindAllowed("code", facts, false) &&
    documentFacts.filter((other) => fieldKindAllowed("code", other, false))
      .length === 1);

/** Whether a code could go into one of a document's inputs, by `codeFieldAllowed`. */
export const hasCodeField = (documentFacts: readonly FieldFacts[]): boolean =>
  documentFacts.some((facts) => codeFieldAllowed(facts, documentFacts));
