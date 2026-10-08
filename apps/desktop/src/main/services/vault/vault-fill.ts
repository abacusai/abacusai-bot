/**
 * What a vault fill may do, decided before any value is asked for: which
 * origin the server is told (always the live page's, never the model's),
 * whether the target frame may receive the value, and, for a card, which
 * approval it fills under and which total the page itself shows. Pure, so
 * every refusal is testable.
 */
import { WAS_PASSWORD_ATTRIBUTE } from "../browser/secret-fields";
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
  field: VaultField;
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
    if (!withinDomain(host, signin.site))
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
  /** Its form (or, with none, its document) has a card-number field besides it. */
  cardPeer: boolean;
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
  adjacentPassword: boolean,
  cardPeer = false
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
    cardPeer,
  };
};

/**
 * The facts of every input in a document, by backend node id, from its DOM
 * as CDP returns it (in document order, not into frames).
 */
export const factsFromDocument = (
  root: DomNode | undefined
): Map<number, FieldFacts> => {
  const inputs: Array<{
    id: number;
    form: DomNode | null;
    attributes: Map<string, string>;
  }> = [];
  const walk = (node: DomNode | undefined, form: DomNode | null): void => {
    if (node == null) return;
    const name = String(node.nodeName ?? "").toUpperCase();
    if (name === "INPUT" && node.backendNodeId != null)
      inputs.push({
        id: node.backendNodeId,
        form,
        attributes: attributesOf(node),
      });
    for (const child of node.children ?? [])
      walk(child, name === "FORM" ? node : form);
  };
  walk(root, null);
  const entries = inputs.filter((input) =>
    TEXT_ENTRY.has(
      (input.attributes.get("type") ?? "text").toLowerCase() || "text"
    )
  );
  const isPassword = (index: number): boolean =>
    (entries[index]?.attributes.get("type") ?? "").toLowerCase() === "password";
  const own = inputs.map((input) => factsOf(input.attributes, false));
  const facts = new Map<number, FieldFacts>();
  for (const [at, input] of inputs.entries()) {
    const index = entries.indexOf(input);
    const cardPeer = inputs.some(
      (other, k) =>
        k !== at && other.form === input.form && cardNumberField(own[k]!)
    );
    facts.set(
      input.id,
      factsOf(
        input.attributes,
        index >= 0 && (isPassword(index - 1) || isPassword(index + 1)),
        cardPeer
      )
    );
  }
  return facts;
};

/**
 * The card vocabulary: the one place that says which words name card data,
 * read over a field's hint words (spaced) and each of its words alone
 * (joined, so "creditCardNumber" and "ccExpMonth" count). Shared by the
 * card rule and every card fill kind.
 */
const CARD_WORDS = {
  /** A card number or its security code: card data by itself. */
  number:
    /\b(?:card|cc) ?(?:num(?:ber)?|no)\b|\b(?:credit|debit) card\b|\b(?:cvv2?|cvc2?|csc)\b/,
  numberJoined: /(?:card|cc)(?:num|no$)|cvv|cvc/,
  /** The expiry, whole or in parts: card data only with card context. */
  expiry: /\bexp(?:iry|iration|ires)?\b|\bvalid (?:thru|through)\b/,
  expiryJoined: /expir|expdate|expmonth|expyears?$|(?:cc|card)exp|validthr/,
  /** The name on the card: card data only with card context. */
  name: /\bname on (?:the )?card\b|\bcard ?holder\b|\bholder(?:s)? name\b|\bcc name\b/,
  nameJoined: /nameoncard|cardholder|holdername|(?:cc|card)name/,
  /** Says the field is about a card. */
  context: /(?<!dis|post)card(?!io)|^cc[a-z]/,
  /** Another document or account: never card data, whatever else it says. */
  excluded:
    /\b(?:passport|document|doc|licen[cs]e|driving|policy|policyholder|account|identity|id|national|travel|birth|dob|experience)\b/,
  excludedJoined:
    /passport|document|licen[cs]e|policy|account|identity|^id(?:exp|num|no|card)|nationalid|travel|birth|experience/,
} as const;

/** What a field's words say about card data. */
export interface CardWording {
  number: boolean;
  expiry: boolean;
  name: boolean;
  /** The words, or a card field beside it, say this is about a card. */
  context: boolean;
  /** The words name another document or account. */
  excluded: boolean;
}

export const cardWording = (facts: FieldFacts): CardWording => {
  const spaced = facts.hints.join(" ");
  const any = (re: RegExp, joinedRe: RegExp): boolean =>
    re.test(spaced) || facts.hints.some((word) => joinedRe.test(word));
  return {
    number: any(CARD_WORDS.number, CARD_WORDS.numberJoined),
    expiry: any(CARD_WORDS.expiry, CARD_WORDS.expiryJoined),
    name: any(CARD_WORDS.name, CARD_WORDS.nameJoined),
    context:
      facts.cardPeer ||
      facts.hints.some((word) => CARD_WORDS.context.test(word)),
    excluded: any(CARD_WORDS.excluded, CARD_WORDS.excludedJoined),
  };
};

/** A card number or CVV field: a cc-number/cc-csc token, or wording that names one. */
const cardNumberField = (facts: FieldFacts): boolean => {
  if (facts.autocomplete.some((t) => t === "cc-number" || t === "cc-csc"))
    return true;
  const wording = cardWording(facts);
  return wording.number && !wording.excluded;
};

/**
 * Whether a field is a card field: any `cc-*` autocomplete token, card
 * number or CVV wording, or expiry or name-on-card wording with card
 * context (card in its words, or a card-number field in its form). Words
 * that name a passport, ID, document, licence, policy or account never
 * count. The one card rule: the host applies it to the facts it recorded
 * at first sighting, the Pay guard's page script to the same facts live.
 */
export const cardField = (facts: FieldFacts): boolean => {
  if (facts.autocomplete.some((token) => token.startsWith("cc-"))) return true;
  const wording = cardWording(facts);
  if (wording.excluded) return false;
  return (
    wording.number || ((wording.expiry || wording.name) && wording.context)
  );
};

const regexJs = (re: RegExp): string =>
  `new RegExp(${JSON.stringify(re.source)})`;

/**
 * In-page `__cardField(facts)` and `__cardNumberField(facts)`: the same rules
 * over `__factsOf` (embedded with `FIELD_FACTS_JS`, which uses them).
 */
const CARD_RULES_JS = `
  const __CARD_WORDS = {
    ${Object.entries(CARD_WORDS)
      .map(([key, re]) => `${key}: ${regexJs(re)}`)
      .join(",\n    ")}
  };
  const __cardWording = (facts) => {
    const spaced = facts.hints.join(' ');
    const any = (re, joinedRe) => re.test(spaced) || facts.hints.some((word) => joinedRe.test(word));
    return {
      number: any(__CARD_WORDS.number, __CARD_WORDS.numberJoined),
      expiry: any(__CARD_WORDS.expiry, __CARD_WORDS.expiryJoined),
      name: any(__CARD_WORDS.name, __CARD_WORDS.nameJoined),
      context: facts.cardPeer || facts.hints.some((word) => __CARD_WORDS.context.test(word)),
      excluded: any(__CARD_WORDS.excluded, __CARD_WORDS.excludedJoined),
    };
  };
  const __cardNumberField = (facts) => {
    if (facts.autocomplete.some((t) => t === 'cc-number' || t === 'cc-csc')) return true;
    const wording = __cardWording(facts);
    return wording.number && !wording.excluded;
  };
  const __cardField = (facts) => {
    if (facts.autocomplete.some((token) => token.startsWith('cc-'))) return true;
    const wording = __cardWording(facts);
    if (wording.excluded) return false;
    return wording.number || ((wording.expiry || wording.name) && wording.context);
  };
`;

/**
 * In-page `__factsOf(el)`: the same facts as `factsFromDocument`, read live
 * (with `__inputs(root)`, the text-entry inputs of a document in order).
 */
export const FIELD_FACTS_JS = `
  ${CARD_RULES_JS}
  const __TEXT_ENTRY = ${JSON.stringify([...TEXT_ENTRY])};
  const __typeOf = (el) => String(el.getAttribute('type') || 'text').toLowerCase() || 'text';
  const __inputs = (root) => Array.from(root.querySelectorAll('input')).filter((el) => __TEXT_ENTRY.includes(__typeOf(el)));
  const __factsOf = (el, peers = true) => {
    const lower = (name) => String(el.getAttribute(name) || '').toLowerCase();
    const scope = (el.form || (el.closest && el.closest('form'))) || el.getRootNode();
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
      hints: [...[lower('name'), lower('id'), lower('aria-label'), lower('placeholder'),
        ...Array.from(el.labels || []).map((label) => String(label.textContent || '').toLowerCase())]
        .join(' ').split(/[^a-z0-9]+/).filter(Boolean),
        ...[lower('name'), lower('id')].map((text) => text.replace(/[^a-z0-9]+/g, '')).filter(Boolean)],
      cardPeer: peers && Array.from(scope.querySelectorAll('input')).some((other) =>
        other !== el && __cardNumberField(__factsOf(other, false))),
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

/** Whether a code could go into one of a document's inputs, by `codeFieldAllowed`. */
export const hasCodeField = (documentFacts: readonly FieldFacts[]): boolean =>
  documentFacts.some((facts) => codeFieldAllowed(facts, documentFacts));
