/**
 * What a vault fill may do, decided before any value is asked for: which
 * origin the server is told (always the live page's, never the model's),
 * whether the target frame may receive the value, and, for a card, which
 * approval it fills under and which total the page itself shows. Pure, so
 * every refusal is testable.
 */
import { WAS_PASSWORD_ATTRIBUTE } from "../browser/secret-fields";
import type { VaultField } from "./vault-client";
import type { PaymentApproval } from "./vault-session";

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

const CARD_FIELDS: ReadonlySet<VaultField> = new Set(["card_number", "cvv"]);

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
  amount?: string;
  currency?: string;
}

export type FillPlan =
  | {
      ok: true;
      request: FillRequest;
      /** The origin the field's own document must still have when it is typed into. */
      documentOrigin: string;
      /** The field is a card field: it is filled once under the approval. */
      once: boolean;
    }
  | { ok: false; error: string };

export interface FillContext {
  itemId: string;
  field: VaultField;
  /** The live origin of the tab's top-level page. */
  topOrigin: string | null;
  /** The live origin of the cross-origin frame the field is in; null when it is in the page. */
  frameOrigin: string | null;
  /** The field is in a cross-origin frame (whose origin may be unknown). */
  inFrame: boolean;
  /** The approval the user granted this session, if any. */
  approval: PaymentApproval | null;
  /**
   * The total the page shows, as the host read it from the element the
   * model pointed at; null when none was named or it could not be read.
   */
  pageTotal: PageTotal | null;
}

const refuse = (error: string): FillPlan => ({ ok: false, error });

/**
 * The origin and approval a fill goes under, or why it may not happen.
 *
 * - A login's username, password or sign-in code is filled for the document
 *   the field is in (the frame's origin in a frame, else the page's), and a
 *   code goes into a cross-origin frame only when it is a payment provider's.
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
      once: false,
    };
  }

  const card = CARD_FIELDS.has(context.field);
  if (
    context.inFrame &&
    (card || context.field === "code") &&
    !isPaymentFrameOrigin(context.frameOrigin)
  )
    return refuse(
      `Refused: that field is in a frame from ${context.frameOrigin}, and a card number, CVV or code is typed ` +
        "only into the page itself or a payment provider's frame. Do not try another way; report where the field is."
    );
  if (!card)
    return {
      ok: true,
      request: { origin: documentOrigin, ...frameOrigin },
      documentOrigin,
      once: false,
    };

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
  if (approval.site.length === 0 || !withinDomain(host, approval.site))
    return refuse(
      `Refused: the payment was approved for ${approval.site || "another site"}, and this page is ${host}. Report where the checkout went.`
    );
  if (approval.used.has(context.field))
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
    once: true,
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
  /** Words naming the field: its name, id, aria-label and placeholder (and, read live, its labels). */
  hints: string[];
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

/**
 * Whether `field` may go into a field with these facts:
 * - password: a field that is or was a password field;
 * - username: a text or email input marked username or email, or right
 *   next to the password field;
 * - card_number / cvv: an input marked cc-number / cc-csc, or a plain input
 *   in a payment provider's frame;
 * - code: an input marked one-time-code, or a short numeric input.
 * Never a search input, and never anything but an input.
 */
export const fieldKindAllowed = (
  field: VaultField,
  facts: FieldFacts,
  inPaymentFrame: boolean
): boolean => {
  if (facts.tag !== "input") return false;
  if (
    facts.type === "search" ||
    facts.role === "searchbox" ||
    facts.inputmode === "search" ||
    facts.enterkeyhint === "search"
  )
    return false;
  const marked = (token: string): boolean => facts.autocomplete.includes(token);
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

/** A DOM node as CDP's `DOM.getDocument` returns it. */
export interface DomNode {
  backendNodeId?: number;
  nodeName?: string;
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
  attributes: Map<string, string>,
  adjacentPassword: boolean
): FieldFacts => {
  const lower = (name: string): string =>
    (attributes.get(name) ?? "").toLowerCase();
  const type = lower("type") || "text";
  const maxLength = Number.parseInt(attributes.get("maxlength") ?? "", 10);
  return {
    tag: "input",
    type,
    autocomplete: lower("autocomplete").split(/\s+/).filter(Boolean),
    role: lower("role"),
    inputmode: lower("inputmode"),
    enterkeyhint: lower("enterkeyhint"),
    pattern: lower("pattern"),
    maxLength: Number.isFinite(maxLength) ? maxLength : -1,
    wasPassword: type === "password" || attributes.has(WAS_PASSWORD_ATTRIBUTE),
    adjacentPassword,
    hints: words(
      ["name", "id", "aria-label", "placeholder"]
        .map((name) => attributes.get(name) ?? "")
        .join(" ")
    ),
  };
};

/**
 * The facts of every input in a document, by backend node id, from its DOM
 * as CDP returns it (in document order, not into frames).
 */
export const factsFromDocument = (
  root: DomNode | undefined
): Map<number, FieldFacts> => {
  const inputs: Array<{ id: number; attributes: Map<string, string> }> = [];
  const walk = (node: DomNode | undefined): void => {
    if (node == null) return;
    if (
      String(node.nodeName ?? "").toUpperCase() === "INPUT" &&
      node.backendNodeId != null
    )
      inputs.push({ id: node.backendNodeId, attributes: attributesOf(node) });
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  const entries = inputs.filter((input) =>
    TEXT_ENTRY.has(
      (input.attributes.get("type") ?? "text").toLowerCase() || "text"
    )
  );
  const isPassword = (index: number): boolean =>
    (entries[index]?.attributes.get("type") ?? "").toLowerCase() === "password";
  const facts = new Map<number, FieldFacts>();
  for (const input of inputs) {
    const index = entries.indexOf(input);
    facts.set(
      input.id,
      factsOf(
        input.attributes,
        index >= 0 && (isPassword(index - 1) || isPassword(index + 1))
      )
    );
  }
  return facts;
};

/**
 * In-page `__factsOf(el)`: the same facts as `factsFromDocument`, read live
 * (with `__inputs(root)`, the text-entry inputs of a document in order).
 */
export const FIELD_FACTS_JS = `
  const __TEXT_ENTRY = ${JSON.stringify([...TEXT_ENTRY])};
  const __typeOf = (el) => String(el.getAttribute('type') || 'text').toLowerCase() || 'text';
  const __inputs = (root) => Array.from(root.querySelectorAll('input')).filter((el) => __TEXT_ENTRY.includes(__typeOf(el)));
  const __factsOf = (el) => {
    const lower = (name) => String(el.getAttribute(name) || '').toLowerCase();
    const type = __typeOf(el);
    const entries = __inputs(el.getRootNode());
    const index = entries.indexOf(el);
    const isPassword = (other) => !!other && __typeOf(other) === 'password';
    const max = parseInt(el.getAttribute('maxlength') || '', 10);
    return {
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
      hints: [lower('name'), lower('id'), lower('aria-label'), lower('placeholder'),
        ...Array.from(el.labels || []).map((label) => String(label.textContent || '').toLowerCase())]
        .join(' ').split(/[^a-z0-9]+/).filter(Boolean),
    };
  };
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
  return Array.from(document.querySelectorAll('input')).map(__factsOf);
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
