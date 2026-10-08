/**
 * The Pay guard: what the browser lets the agent activate during a checkout.
 * Every activation (a click, a key that can activate or submit, a checkbox,
 * a select, a pick, a dismiss, and navigation away from a payment step)
 * passes through one host-side check in `McpBrowserServer`, every time,
 * retries included. This module is that check's decisions, pure.
 *
 * Fail closed. Once the tab is on a payment step, or the checkout is past the
 * review (the approval and after), an activation goes through only when it
 * is one of a few field and method controls (text fields, selects, radios,
 * checkboxes other than "save this card", a section that expands a card
 * method), or when it is the one payment the user approved:
 * - a live approval for the site the page is on, not yet used for a payment;
 * - the total the page shows (read by the host from the element the run
 *   names, as the card fill reads it) equals the approved amount and currency;
 * - no card the site saved is selected.
 * That commit uses the approval up: a second commit needs a new approval.
 * After it, the bank's code step may submit once.
 *
 * Off a payment step, words are one extra signal: a control whose words or
 * attributes commit ("Pay", "Place order", "Confirm booking", "Book now",
 * and the same in a few other languages) is refused without an approval.
 *
 * Always refused: UPI and wallet apps (they approve in the user's own app),
 * a card the site saved, and ticking "save this card".
 *
 * The facts are read in an isolated world, so the page's own scripts cannot
 * answer for it; facts that cannot be read refuse the activation.
 *
 * `browser_execute` is refused outright while a checkout is past search or
 * the tab is on a payment step: a script is not an element to check.
 *
 * What a payment step is: the document has card fields (autocomplete `cc-*`,
 * card number, CVV or expiry inputs, or a field the vault typed card data
 * into; never a field merely masked, such as a filled login or a code), embeds a
 * payment provider's frame or a frame that says it takes payment, submits a
 * form with card fields, is a provider's frame itself, has a checkout or
 * payment path, or its origin was a payment step earlier in this checkout.
 *
 * Limits: a payment step with none of those marks (a card form drawn on a
 * canvas, in a closed shadow root, behind a frame with no telling attributes)
 * is guarded only by the words signal until the checkout is past the review.
 */
import { CARD_ATTRIBUTE } from "../browser/secret-fields";
import { onSite, sameSite } from "./site";
import {
  isPaymentFrameOrigin,
  PAYMENT_FRAME_HOSTS,
  type PageTotal,
  sameAmount,
} from "./vault-fill";

/** Marks the facts script, for tests that answer it. */
export const PAY_GUARD_MARKER = "abacusai-pay-guard";

/** What a control is, as far as the guard is concerned. */
export type ControlKind =
  | "text-field"
  | "select"
  | "radio"
  | "checkbox"
  | "card-method"
  | "frame"
  | "submit"
  | "link"
  | "other";

/** What the page says about the control an action would act on, and its document. */
export interface ControlFacts {
  /** False when no element matched; the action reports that itself. */
  found: boolean;
  kind: ControlKind;
  /** What a person reads on the control, whitespace-collapsed. */
  label: string;
  /** Its identifying attributes, lowercased and space-joined. */
  attrs: string;
  /** A checkbox or radio is checked now. */
  checked: boolean;
  /** The URL of the document it sits in. */
  url: string;
  /** The document has card fields, or a field the vault typed card data into. */
  cardFields: boolean;
  /** The document embeds a payment provider's frame, or one that says it takes payment. */
  paymentFrame: boolean;
  /** It submits a form that has card fields. */
  submitsCardForm: boolean;
  /** A card the site saved is selected on the page. */
  savedCardSelected: boolean;
  /** The page shows a card by its last digits (a card list, a saved-card summary). */
  maskedCardOnPage: boolean;
  /** The page shows a price with its currency. */
  priceOnPage: boolean;
  /** Some button, link or submit on the page commits by its words or attributes ("Buy now"). */
  commitControlOnPage: boolean;
  /** The control's ARIA role, lowercased. */
  role: string;
  /** The control expands or collapses a section (aria-expanded, a details summary). */
  expands: boolean;
  /** For a focused frame: whether it is a payment provider's. */
  frameIsProvider: boolean;
}

/** An activation, as the server is about to perform it. */
export type Activation =
  | { action: "click"; selector: string }
  | { action: "check" | "uncheck"; selector: string }
  | { action: "select"; selector: string; option: string }
  /** A key pressed into the focused element (a selector when the key is aimed). */
  | { action: "key"; key: string; selector?: string };

/** Keys that activate a control or submit its form. */
const ACTIVATING_KEYS = new Set([
  "enter",
  "numpadenter",
  "return",
  " ",
  "space",
  "spacebar",
  "\r",
  "\n",
  "\r\n",
]);

/** The key a combo ends in ("Shift+Enter" → "Enter"), kept as is for a bare "+" or space. */
const mainKey = (key: string): string => {
  if (key.length <= 2) return key;
  return key.split("+").at(-1) ?? key;
};

/** Whether pressing `key` can activate the focused control or submit a form. */
export const activatesControl = (key: string): boolean =>
  ACTIVATING_KEYS.has(mainKey(key).toLowerCase()) ||
  /[\r\n]/.test(key) ||
  key === " ";

/** Whether `key` is Space (activates a checkbox or radio, never submits a form). */
export const isSpaceKey = (key: string): boolean =>
  [" ", "space", "spacebar"].includes(mainKey(key).toLowerCase()) ||
  key === " ";

/**
 * The script that reads `ControlFacts` in the control's document: the element
 * `selector` names, or with none the focused element. `enter`: the key would
 * submit, so a focused form field stands for its form's submitter.
 */
export const controlFactsScript = (
  selector: string | null,
  options: { enter?: boolean; option?: string | null } = {}
): string => `(function() { /* ${PAY_GUARD_MARKER} */
  const hosts = ${JSON.stringify(PAYMENT_FRAME_HOSTS)};
  const squash = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
  const providerHost = (url) => {
    try {
      const host = new URL(url, location.href).hostname.toLowerCase();
      return hosts.some((domain) => host === domain || host.endsWith('.' + domain));
    } catch { return false; }
  };
  // Card fields by payment facts only: a cc-* autocomplete token, card naming, or the vault's card mark.
  const CARD_NAMED = 'input[name*="cardnum" i], input[name*="card_num" i], input[name*="card-num" i], ' +
    'input[id*="cardnum" i], input[id*="card_num" i], input[id*="card-num" i], input[name*="cvv" i], input[name*="cvc" i], ' +
    'input[id*="cvv" i], input[id*="cvc" i], input[name*="expiry" i], input[name*="exp_month" i], [${CARD_ATTRIBUTE}]';
  const isCard = (el) => el.matches(CARD_NAMED) ||
    String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/).some((token) => token.startsWith('cc-'));
  const hasCard = (root) => {
    try { return Array.from(root.querySelectorAll('input, select, textarea, [${CARD_ATTRIBUTE}]')).some(isCard); }
    catch { return false; }
  };
  const payingFrame = (frame) => {
    const words = [frame.getAttribute('title'), frame.getAttribute('name'), frame.getAttribute('id'),
      frame.getAttribute('class'), frame.getAttribute('aria-label')].join(' ');
    return providerHost(frame.getAttribute('src') || '') ||
      /(^|\\s)payment(\\s|$)/i.test(frame.getAttribute('allow') || '') ||
      /card|payment|checkout|3ds|3-d secure|secure pay|cvv|cvc/i.test(words);
  };
  const textOf = (node) => {
    const parts = [node.innerText || node.textContent || ''];
    if (/^(submit|button|image)$/i.test(node.type || '')) parts.push(node.value || '');
    for (const name of ['aria-label', 'title', 'alt']) parts.push(node.getAttribute(name) || '');
    if (node.labels) for (const label of node.labels) parts.push(label.innerText || label.textContent || '');
    const around = node.closest && node.closest('label');
    if (around) parts.push(around.innerText || around.textContent || '');
    return parts.join(' ');
  };
  const MASKED = /(?:[*\\u2022x]{2,}\\s?){1,3}\\d{4}\\b|\\bending\\s+(?:in\\s+|with\\s+)?\\d{4}\\b|\\bsaved\\s+cards?\\b/i;
  let savedCardSelected = false;
  try {
    for (const choice of document.querySelectorAll('input[type=radio]:checked, [role=radio][aria-checked=true], [aria-selected=true]'))
      if (MASKED.test(squash(textOf(choice)))) { savedCardSelected = true; break; }
  } catch {}
  const bodyText = squash(document.body ? (document.body.innerText || document.body.textContent || '') : '').slice(0, 20000);
  const MASKED_DIGITS = /(?:[*\u2022x]{2,}\\s?){1,3}\\d{4}\\b|\\bending\\s+(?:in\\s+|with\\s+)?\\d{4}\\b/i;
  const PRICE = /(?:[\u20b9$\u20ac\u00a3\u00a5\u20a9]|\\b(?:INR|USD|EUR|GBP|AED|SGD|AUD|CAD|Rs\\.?))\\s?\\d[\\d.,]*/;
  const page = {
    url: location.href,
    cardFields: hasCard(document),
    paymentFrame: Array.from(document.querySelectorAll('iframe, frame')).some(payingFrame),
    savedCardSelected,
    maskedCardOnPage: MASKED_DIGITS.test(bodyText),
    priceOnPage: PRICE.test(bodyText),
    commitControlOnPage: false,
  };
  try {
    const commitWords = ${JSON.stringify(COMMIT_WORDS.map((words) => [words.source, words.flags]))}
      .map(([source, flags]) => new RegExp(source, flags));
    const commitAttrs = new RegExp(${JSON.stringify(COMMIT_ATTRS.source)}, ${JSON.stringify(COMMIT_ATTRS.flags)});
    const controls = document.querySelectorAll('button, a[href], [role=button], [role=link], input[type=submit], input[type=button], input[type=image]');
    for (let index = 0; index < controls.length && index < 2000; index++) {
      const node = controls[index];
      const label = squash(textOf(node)).slice(0, 200);
      const attrs = ['id', 'name', 'class', 'value', 'data-testid', 'data-test', 'data-qa', 'data-action', 'formaction', 'href']
        .map((name) => node.getAttribute(name) || '').join(' ').toLowerCase();
      if (commitWords.some((words) => words.test(label)) || commitAttrs.test(attrs)) {
        page.commitControlOnPage = true;
        break;
      }
    }
  } catch {
    // Unread, assume the worst.
    page.commitControlOnPage = true;
  }
  const none = { label: '', attrs: '', checked: false, submitsCardForm: false, frameIsProvider: false, role: '', expands: false };
  let el = ${selector == null ? "document.activeElement" : `document.querySelector(${JSON.stringify(selector)})`};
  if (!el || el === document.body || el === document.documentElement)
    return Object.assign({ found: ${selector == null ? "true" : "false"}, kind: 'other' }, none, page);
  if (/^(IFRAME|FRAME)$/.test(el.tagName))
    return Object.assign({ found: true, kind: 'frame' }, none, page,
      { frameIsProvider: providerHost(el.getAttribute('src') || ''), paymentFrame: page.paymentFrame || payingFrame(el) });
  const type = String(el.type || '').toLowerCase();
  const field = /^(INPUT|TEXTAREA)$/.test(el.tagName) && !/^(submit|button|image|reset|checkbox|radio|file|hidden|range|color)$/.test(type);
  const form = el.form || (el.closest && el.closest('form'));
  if (${options.enter === true} && (field || el.isContentEditable) && form) {
    // Enter in a field submits its form: what is checked is the form's submitter.
    const submitter = Array.from(form.elements || []).find((item) =>
      item.type === 'submit' || item.type === 'image' ||
      (item.tagName === 'BUTTON' && !/^(button|reset)$/i.test(item.getAttribute('type') || '')));
    el = submitter || form;
  }
  const control = (el.closest && el.closest('button, a[href], [role=button], [role=link], [role=radio], [role=checkbox], ' +
    '[role=tab], [role=option], input, select, textarea, label, summary')) || el;
  const target = control.tagName === 'LABEL' && control.control ? control.control : control;
  const ttype = String(target.type || '').toLowerCase();
  const role = String(target.getAttribute('role') || '').toLowerCase();
  const tform = target.form || (target.closest && target.closest('form'));
  const submits = target.tagName === 'FORM' || ttype === 'submit' || ttype === 'image' ||
    (target.tagName === 'BUTTON' && !/^(button|reset)$/i.test(target.getAttribute('type') || '') && !!tform);
  const words = squash([textOf(control), control === el ? '' : textOf(el), ${JSON.stringify(options.option ?? "")}].join(' '));
  const CARD_METHOD = /\\b(credit|debit)\\b|\\bcards?\\b|tarjeta|carte|karte|cart[aã]o|kartu|कार्ड/i;
  let kind = 'other';
  if (/^(INPUT|TEXTAREA)$/.test(target.tagName) && !/^(submit|button|image|reset|checkbox|radio)$/.test(ttype)) kind = 'text-field';
  else if (target.isContentEditable) kind = 'text-field';
  else if (target.tagName === 'SELECT' || role === 'option' && target.closest('[role=listbox]')) kind = 'select';
  else if (ttype === 'radio' || role === 'radio') kind = 'radio';
  else if (ttype === 'checkbox' || role === 'checkbox') kind = 'checkbox';
  else if (submits) kind = 'submit';
  else if (!submits && words.length <= 40 && CARD_METHOD.test(words) &&
    (role === 'tab' || target.tagName === 'SUMMARY' || target.hasAttribute('aria-expanded') || target.hasAttribute('aria-controls')))
    kind = 'card-method';
  else if (target.tagName === 'A') kind = 'link';
  const attrs = [];
  for (const node of control === el ? [el] : [control, el])
    for (const name of ['id', 'name', 'class', 'value', 'data-testid', 'data-test', 'data-qa', 'data-action',
      'data-cy', 'formaction', 'href'])
      attrs.push(node.getAttribute(name) || '');
  return Object.assign({}, page, {
    found: true,
    kind,
    label: words.slice(0, 400),
    attrs: squash(attrs.join(' ')).toLowerCase().slice(0, 400),
    checked: target.checked === true || target.getAttribute('aria-checked') === 'true',
    submitsCardForm: submits && !!tform && hasCard(tform),
    frameIsProvider: false,
    role,
    expands: target.tagName === 'SUMMARY' || target.hasAttribute('aria-expanded'),
  });
})()`;

/** The facts of the top document alone, for navigation and scripts. */
export const pageFactsScript = (): string => controlFactsScript(null);

// Words, checked against `label` (case-insensitive).

/** Words that commit to paying or booking wherever they appear. */
const COMMIT_WORDS: readonly RegExp[] = [
  // "Pay", "Pay now", "Pay ₹1,234": not "payment", "PayPal", or a method picker.
  /\bpay\b(?!\s+(?:with|using|by|via|through)\b)/i,
  /\bplace\s+(?:your\s+|my\s+)?order\b/i,
  /\b(?:complete|confirm|finali[sz]e|submit)\s+(?:and\s+|&\s+)?(?:pay|purchase|order|booking|payment|reservation|checkout)\b/i,
  /\b(?:book|buy|order|purchase|reserve)\s+now\b/i,
  /\bconfirm\s+(?:and|&)\s+(?:book|buy|pay|reserve)\b/i,
  /\bmake\s+(?:a\s+)?payment\b/i,
  /\bproceed\s+to\s+pay\b/i,
  /^\s*(?:purchase|checkout\s+and\s+pay)\b/i,
  // A few other languages, for the same few verbs.
  /\b(?:pagar|paga|payer|bezahlen|zahlen|betalen|betala|оплатить|ödeme|bayar)\b/i,
  /\b(?:comprar|acheter|kaufen|kopen|reservar\s+ahora|réserver|buchen|zahlungspflichtig)\b/i,
  /(?:支付|付款|購入する|支払う|결제|भुगतान\s*करें|ادفع)/,
];

/** Attribute tokens of pay and order-submit buttons (`btn-pay`, `placeOrder`). */
const COMMIT_ATTRS =
  /(?:^|[^a-z])(?:pay(?:now|button|btn)?|btnpay|place-?_?order|submit-?_?(?:order|payment)|complete-?_?(?:purchase|order|booking|payment)|confirm-?_?(?:booking|payment|order|purchase)|book-?_?now|buy-?_?now)(?:[^a-z]|$)/i;

/** UPI and the wallets that approve in the user's own app. */
const UPI =
  /\bupi\b|\bvpa\b|\bbhim\b|google\s*pay|\bg-?pay\b|phone\s*pe|paytm|amazon\s*pay|mobikwik|freecharge|@(?:ybl|ibl|axl|upi|paytm|okicici|oksbi|okaxis|okhdfcbank)\b/i;

/** A card the site saved, by name. */
const SAVED_CARD =
  /\bsaved\s+cards?\b|\buse\s+(?:a\s+|my\s+|this\s+)?saved\b|\bstored\s+cards?\b/i;

/** A card shown by its last digits, as a site lists the cards it keeps. */
const MASKED_CARD =
  /(?:[*•x]{2,}\s?){1,3}\d{4}\b|\bending\s+(?:in\s+|with\s+)?\d{4}\b/i;

/** The box that would have the site keep the card. */
const SAVE_CARD_BOX =
  /\b(?:save|remember|store|keep)\b.{0,30}\bcards?\b|\bcards?\b.{0,20}\b(?:for\s+(?:future|later|next\s+time))\b/i;

const PAYMENT_PATH =
  /\/(?:checkout|payments?|pay|billing|purchase|place-?order)(?:[/?#._-]|$)/i;

/** A URL that does the committing itself, when merely loaded. */
const COMMIT_URL =
  /\/(?:pay(?:ment)?\/(?:confirm|submit|complete|process)|place-?order|confirm-?booking|complete-?(?:purchase|order|booking)|submit-?order|book-?now|buy-?now)(?:[/?#._-]|$)|[?&](?:action|step)=(?:pay|place_?order|confirm|purchase)\b/i;

/** The origin of a URL, or null for one that has none (about:blank). */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

/** A review or confirmation page, by its path. */
const REVIEW_PATH =
  /\/(?:review|confirm(?:ation)?|summary|order-?summary|itinerary|trip-?summary)(?:[/?#._-]|$)/i;

/**
 * A step where the card is in play: card fields, a payment provider's frame,
 * a form with card fields, a card the site saved shown or selected, a
 * provider's own frame, or a checkout/payment path. A commit here is the
 * payment itself.
 */
export function cardStep(facts: ControlFacts): boolean {
  if (
    facts.cardFields ||
    facts.paymentFrame ||
    facts.submitsCardForm ||
    facts.savedCardSelected ||
    facts.maskedCardOnPage
  )
    return true;
  let url: URL;
  try {
    url = new URL(facts.url);
  } catch {
    return false;
  }
  return isPaymentFrameOrigin(url.origin) || PAYMENT_PATH.test(url.pathname);
}

/** A review or confirmation page showing a price: the step before the card. */
export function reviewStep(facts: ControlFacts): boolean {
  let path: string;
  try {
    path = new URL(facts.url).pathname;
  } catch {
    return false;
  }
  return facts.priceOnPage && REVIEW_PATH.test(path);
}

/** Whether the document the facts are of is a payment step by its own marks. */
export function looksLikePaymentStep(facts: ControlFacts): boolean {
  return cardStep(facts) || reviewStep(facts);
}

/** Whether a control's words or attributes commit to a payment or booking. */
export function wordsCommit(facts: ControlFacts): boolean {
  return (
    COMMIT_WORDS.some((words) => words.test(facts.label)) ||
    COMMIT_ATTRS.test(facts.attrs)
  );
}

export const UNREADABLE_REFUSAL =
  "Refused: the browser could not check this control, so it was not activated. Take a snapshot and try again; " +
  'if the page is at its payment step, stop with browser_pause need:"payment".';
export const UPI_REFUSAL =
  "Refused: UPI and wallet apps are never used here. They approve the payment in the user's own app, " +
  "outside the approval they gave. Pay with the approved vault card, or stop and report.";
export const SAVED_CARD_REFUSAL =
  "Refused: a card the site saved is never used here, approved or not. Choose to enter a new card and fill the " +
  "vault card with browser_vault_fill.";
export const SAVE_CARD_REFUSAL =
  "Refused: the site is not asked to keep the card. Leave that box unchecked.";
export const PAY_REFUSAL =
  "Refused: this would complete a payment or booking, and the user has not approved this payment. " +
  'Stop with browser_pause need:"payment" on the page with the card form, naming the total with total_ref; ' +
  "the user approves it on their own page, then the run continues.";
export const STEP_REFUSAL =
  "Refused: on a payment step only fields, choices and the card-method section can be used until the user " +
  'approves the payment. Stop with browser_pause need:"payment".';
export const FRAME_REFUSAL =
  "Refused: the focus is inside a frame from another site on a payment step. Click a field by its ref instead.";
export const USED_REFUSAL =
  "Refused: the user's approval covered one payment, and it was made. Anything more needs a new approval.";
export const SITE_REFUSAL =
  "Refused: the payment was approved for another site than the one this page is on. Report where the checkout went.";
export const TOTAL_NOT_ANCHORED =
  "Refused: a payment goes through only against the total the browser anchored when the run stopped for the " +
  'payment (or that the card fill checked). Stop with browser_pause need:"payment" naming the total with total_ref.';
export const TOTAL_MISSING_REFUSAL =
  "Refused: the payment goes through only against the total the page shows. Pass total_ref, the ref of the element " +
  'showing the order total with its currency (e.g. "Total ₹1,234.00"), with this action.';
export const totalMismatchRefusal = (
  total: PageTotal,
  amount: string,
  currency: string
): string =>
  `Refused: the page shows ${total.amount}${total.currencies.length > 0 ? ` (${total.currencies.join("/")})` : " with no currency"}, ` +
  `and the user approved ${amount} ${currency}. Do not pay. Report the total the page shows; the user approves it again.`;

/** Where the checkout and its approval stand, for one activation. */
export interface GuardState {
  /** The origin was a payment step earlier in this checkout. */
  knownPaymentStep: boolean;
  /** The checkout is at or past the payment approval. */
  pastReview: boolean;
  /** The checkout is at the bank's code step. */
  bankStep: boolean;
  approval: {
    /** A granted approval, still in time. */
    live: boolean;
    /** It covers the site the tab's top page is on. */
    coversSite: boolean;
    /** The payment went through under it. */
    paid: boolean;
    /** The one step from the review toward the payment went through under it. */
    reviewed: boolean;
    /** Its bank-code submit already went through. */
    bankSubmitted: boolean;
  };
}

/**
 * A commit's tier. "pay": on a step where the card is in play, the payment
 * itself, which spends the approval. "review": a commit before the card
 * (the review's Continue, a pay-later "Confirm booking"), allowed once
 * under the approval, against the same total.
 */
export type CommitTier = "pay" | "review";

/**
 * The guard's first word on an activation: let it, refuse it, or treat it as
 * a commit, which `commitVerdict` decides against the total.
 */
export type ActivationVerdict =
  | { kind: "allow" }
  | { kind: "refuse"; reason: string }
  | { kind: "commit"; tier: CommitTier }
  | { kind: "bank" };

/** Controls that open, close or pick inside the page and commit nothing. */
const SAFE_ROLES = new Set([
  "listbox",
  "option",
  "combobox",
  "menu",
  "menuitem",
  "menuitemradio",
  "tab",
  "treeitem",
]);
const SAFE_WORDS =
  /^\s*(?:view|show|hide|see|more|less)\b.{0,20}\b(?:details?|breakdown|summary|fare rules?|terms|info(?:rmation)?)\b|^\s*(?:view|show|hide)\s+(?:more|less)\s*$/i;

export const REVIEW_COMMIT_REFUSAL =
  "Refused: this would book or order before the card is entered (pay later, cash on delivery or a saved method). " +
  "That is for the user to finish themselves. Go on to the card form instead, or report how the page wants payment.";
export const OTHER_REFUSAL =
  "Refused: on a payment step only fields, choices, menus and the card-method section are used, besides the one " +
  "payment the user approved. This control is none of those.";

export function activationVerdict(
  activation: Activation,
  facts: ControlFacts | null,
  state: GuardState
): ActivationVerdict {
  const allow: ActivationVerdict = { kind: "allow" };
  if (activation.action === "key" && !activatesControl(activation.key))
    return allow;
  if (facts == null) return { kind: "refuse", reason: UNREADABLE_REFUSAL };
  if (!facts.found) return allow;
  if (activation.action === "uncheck") return allow;

  const words = `${facts.label} ${facts.attrs}`;
  if (UPI.test(words)) return { kind: "refuse", reason: UPI_REFUSAL };
  const ticking =
    activation.action === "check" ||
    (!facts.checked &&
      (activation.action === "click" ||
        (activation.action === "key" && isSpaceKey(activation.key))));
  if (facts.kind === "checkbox" && ticking && SAVE_CARD_BOX.test(facts.label))
    return { kind: "refuse", reason: SAVE_CARD_REFUSAL };
  const choosing =
    facts.kind === "radio" ||
    facts.kind === "checkbox" ||
    facts.kind === "select" ||
    facts.kind === "other" ||
    facts.kind === "link";
  if (
    SAVED_CARD.test(facts.label) ||
    (choosing && MASKED_CARD.test(facts.label))
  )
    return { kind: "refuse", reason: SAVED_CARD_REFUSAL };

  const strict =
    state.pastReview || state.knownPaymentStep || looksLikePaymentStep(facts);
  const fieldOrMethod =
    activation.action === "key"
      ? isSpaceKey(activation.key) &&
        (facts.kind === "checkbox" || facts.kind === "radio")
      : facts.kind === "text-field" ||
        facts.kind === "select" ||
        facts.kind === "radio" ||
        facts.kind === "checkbox" ||
        facts.kind === "card-method";
  if (strict && fieldOrMethod) return allow;
  if (strict && facts.kind === "frame" && !facts.frameIsProvider)
    return { kind: "refuse", reason: FRAME_REFUSAL };

  // What commits on a payment step: a submit control, words or attributes
  // that commit, a key into a provider's card frame, or Enter that submits.
  const submitsByKey =
    activation.action === "key" &&
    !isSpaceKey(activation.key) &&
    facts.kind !== "text-field";
  // Off a payment step, only words and attributes say a control commits.
  const commits = strict
    ? facts.kind === "submit" ||
      wordsCommit(facts) ||
      (facts.kind === "frame" && facts.frameIsProvider) ||
      submitsByKey
    : wordsCommit(facts);
  if (!commits) {
    if (!strict) return allow;
    // On a payment step, what commits nothing: menus, expanders, details.
    const safe =
      activation.action !== "key" &&
      (SAFE_ROLES.has(facts.role) ||
        facts.expands ||
        SAFE_WORDS.test(facts.label));
    return safe ? allow : { kind: "refuse", reason: OTHER_REFUSAL };
  }

  // A saved card on the page is never what pays, approved or not.
  if (facts.savedCardSelected)
    return { kind: "refuse", reason: SAVED_CARD_REFUSAL };
  if (
    state.bankStep &&
    state.approval.live &&
    state.approval.paid &&
    !state.approval.bankSubmitted
  )
    return { kind: "bank" };
  if (!state.approval.live)
    return {
      kind: "refuse",
      reason: strict && !wordsCommit(facts) ? STEP_REFUSAL : PAY_REFUSAL,
    };
  if (state.approval.paid) return { kind: "refuse", reason: USED_REFUSAL };
  if (!state.approval.coversSite)
    return { kind: "refuse", reason: SITE_REFUSAL };
  const tier: CommitTier = cardStep(facts) ? "pay" : "review";
  // Before the card, only a step on toward it ("Continue", "Next"): a control
  // that commits by its words there books without the card (pay later, cash
  // on delivery, a saved method), which the user finishes themselves.
  if (tier === "review" && wordsCommit(facts))
    return { kind: "refuse", reason: REVIEW_COMMIT_REFUSAL };
  if (tier === "review" && state.approval.reviewed)
    return { kind: "refuse", reason: USED_REFUSAL };
  return { kind: "commit", tier };
}

/** The payment itself: the page's total against the approval. Null lets it through. */
export function commitVerdict(
  total: PageTotal | null,
  approval: { amount: string; currency: string }
): string | null {
  if (total == null) return TOTAL_MISSING_REFUSAL;
  if (
    !sameAmount(total.amount, approval.amount) ||
    !total.currencies.includes(approval.currency)
  )
    return totalMismatchRefusal(total, approval.amount, approval.currency);
  return null;
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

export type NavigationAction = "goto" | "back" | "forward" | "reload";

export const NAVIGATION_REFUSAL =
  "Refused: on a payment step, or past the payment approval, the browser does not load the same site's pages by URL, " +
  "reload, or go forward: any of those can submit the payment. Use the page's own controls, or go back.";
export const COMMIT_URL_REFUSAL =
  "Refused: that address would place the order or take the payment, and the user has not approved this payment.";

/**
 * Navigation from the tab's page: refused when it could commit. `strict` is
 * whether the page is guarded (a payment step, or past the review); null when
 * the page could not be read.
 */
export function navigationVerdict(input: {
  action: NavigationAction;
  from: string;
  to: string | null;
  strict: boolean | null;
  approvalLive: boolean;
}): string | null {
  if (input.action === "back") return null;
  const fromHost = originOf(input.from) != null ? hostOf(input.from) : null;
  // Nothing to submit from a blank or error page.
  if (fromHost == null) return null;
  if (input.action === "goto") {
    const toHost = input.to != null ? hostOf(input.to) : null;
    if (toHost == null || !sameSite(toHost, fromHost))
      // Off to another site: refused only for an address that commits by itself.
      return input.strict !== false &&
        !input.approvalLive &&
        input.to != null &&
        COMMIT_URL.test(input.to)
        ? COMMIT_URL_REFUSAL
        : null;
    if (input.strict !== false) return NAVIGATION_REFUSAL;
    if (!input.approvalLive && input.to != null && COMMIT_URL.test(input.to))
      return COMMIT_URL_REFUSAL;
    return null;
  }
  return input.strict === true ? NAVIGATION_REFUSAL : null;
}

export const COMMIT_PAGE_EXECUTE_REFUSAL =
  'Refused: this page has a control that would buy, order or book ("Buy now", "Place order"), so scripts do not ' +
  "run on it. Use browser_snapshot and browser_interact.";
export const EXECUTE_REFUSAL =
  "Refused: scripts do not run during a checkout or on a payment step. Use browser_snapshot and browser_interact.";

/** Whether an approval for `site` (a registrable domain) covers a page at `origin`. */
export function approvalCovers(site: string, origin: string | null): boolean {
  if (origin == null) return false;
  const host = hostOf(origin);
  return host != null && onSite(host, site);
}
