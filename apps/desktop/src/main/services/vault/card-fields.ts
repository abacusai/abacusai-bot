/**
 * Which of a document's fields are card fields, decided by structure as much
 * as by words. One function for the host (over the DOM it records at first
 * sighting) and for the Pay guard's page script (over the live DOM): the
 * page script embeds these functions' own source, so there is no second copy.
 *
 * - A card number or CVV: a `cc-number` / `cc-csc` token, or the field's own
 *   words naming one ("Card number", "cardNumber", "CVV", "Credit card or
 *   bank account number"). A "card" a word qualifies as another kind (gift,
 *   loyalty, rail, membership, ID, club, library, student, transit…) does
 *   not count, and neither does a PAN or Aadhaar field. A travel card is a
 *   prepaid payment card, so "Travel card number" counts.
 * - An expiry or cardholder name: a `cc-exp*` / `cc-name` token, or its
 *   words naming one AND a qualifying number or CVV field beside it: in the
 *   same fieldset or group, or within three fields of it in document order,
 *   in the same form. Card words in its own name are not enough, and
 *   passport, visa, ticket or document wording never counts as beside.
 *
 * Callers add what only they know: a payment provider's frame, and a field
 * the vault typed card data into.
 *
 * Both functions must stay self-contained (no outside names), and linear in
 * the number of fields.
 */

export type CardDetail = "exp" | "exp_month" | "exp_year" | "name";

/** One form control, in document order, as `classifyCardControls` reads it. */
export interface CardControl {
  /** Its naming texts' words, phrase by phrase (`cardPhrases`). */
  phrases: string[][];
  autocomplete: string[];
  /** A field a person fills (a text-like input or a select). */
  fillable: boolean;
  /** Its form (`el.form`), as a key; 0 for none. */
  form: number;
  /** Its nearest fieldset or `role=group`, as a key; 0 for none. */
  group: number;
}

export interface CardClass {
  /** A card number or CVV field. */
  number: boolean;
  /** What its tokens or words say it is, ignoring where it is. */
  detailWords: CardDetail | null;
  /** A card expiry or name field: by token, or by words beside a number field. */
  detail: CardDetail | null;
}

/**
 * The meaningful words of a field's naming texts (name, id, aria-label,
 * placeholder, labels), one array per text: camelCase split, lowercased,
 * bare numbers dropped ("input-id-12" gives ["input", "id"], which name
 * nothing). A joined form is kept beside the split one ("creditcardnumber").
 */
export function cardPhrases(texts: string[]): string[][] {
  const phrases: string[][] = [];
  for (const text of texts) {
    const raw = String(text || "");
    if (raw.length === 0) continue;
    const split = raw
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 0 && !/^[0-9]+$/.test(word));
    if (split.length === 0) continue;
    const joined = raw.toLowerCase().replace(/[^a-z]+/g, "");
    phrases.push(
      split.length > 1 && joined.length > 0 ? [...split, joined] : split
    );
  }
  return phrases;
}

/** Each control's card class, in one pass over the document's controls. */
export function classifyCardControls(controls: CardControl[]): CardClass[] {
  // "card" qualified as something other than a payment card.
  const OTHER_CARD = [
    "gift",
    "loyalty",
    "rail",
    "membership",
    "member",
    "id",
    "identity",
    "club",
    "library",
    "student",
    "transit",
    "metro",
    "reward",
    "rewards",
    "store",
    "discount",
    "fuel",
    "ration",
    "voter",
    "health",
    "insurance",
    "pan",
    "aadhaar",
    "aadhar",
    "sim",
    "business",
    "visiting",
    "report",
  ];
  const NOT_CARD_NUMBER = ["pan", "aadhaar", "aadhar"];
  const NUMBER_WORDS = ["number", "num", "no", "nr", "nbr"];
  const CVV_WORDS = ["cvv", "cvv2", "cvc", "cvc2", "csc", "cvn", "cid"];
  const NOT_BESIDE = ["passport", "visa", "ticket", "document", "documents"];
  const NOT_EXPIRY = [
    "dd",
    "day",
    "birth",
    "dob",
    "birthday",
    "issue",
    "issued",
  ];
  const NOT_HOLDER = [
    "first",
    "last",
    "middle",
    "user",
    "username",
    "company",
    "business",
    "bank",
    "street",
    "nick",
    "display",
    "file",
    "account",
    "policy",
  ];
  const otherCard = (word: string): boolean => {
    if (OTHER_CARD.indexOf(word) >= 0) return true;
    for (const other of OTHER_CARD)
      if (word === other + "card" || word.indexOf(other + "card") === 0)
        return true;
    return false;
  };
  const numberish = (control: CardControl): boolean => {
    const tokens = control.autocomplete;
    if (tokens.indexOf("cc-number") >= 0 || tokens.indexOf("cc-csc") >= 0)
      return true;
    for (const phrase of control.phrases)
      for (const word of phrase)
        if (NOT_CARD_NUMBER.indexOf(word) >= 0) return false;
    for (const phrase of control.phrases) {
      for (let i = 0; i < phrase.length; i++) {
        const word = phrase[i]!;
        const before = i > 0 ? phrase[i - 1]! : "";
        const after = i + 1 < phrase.length ? phrase[i + 1]! : "";
        if (CVV_WORDS.indexOf(word) >= 0) return true;
        if (/^(?:cvv|cvc)[a-z0-9]*$/.test(word)) return true;
        // "card number", "cc no"; not "gift card number".
        if (
          (word === "card" || word === "cc") &&
          NUMBER_WORDS.indexOf(after) >= 0 &&
          !otherCard(before)
        )
          return true;
        // "credit card", "debit card" name the card itself.
        if ((word === "credit" || word === "debit") && after === "card")
          return true;
        // "card security code", "card verification value".
        if (
          word === "card" &&
          (after === "security" || after === "verification") &&
          !otherCard(before)
        )
          return true;
        // Joined: "cardnumber", "creditcardnumber", "ccnum"; not "giftcardnumber".
        // "cc" only at the start: "accno" is an account number.
        const joined = /^([a-z]*?)(card|cc)(number|num|no|nr)$/.exec(word);
        if (
          joined != null &&
          (joined[2] === "card" || joined[1] === "") &&
          !otherCard(joined[1]!) &&
          !otherCard(before)
        )
          return true;
        // "xcard number" as one word and the next ("railcard number").
        if (
          word.length > 4 &&
          word.slice(-4) === "card" &&
          NUMBER_WORDS.indexOf(after) >= 0 &&
          !otherCard(word) &&
          !otherCard(before)
        )
          return true;
      }
    }
    return false;
  };
  const detailOf = (control: CardControl): CardDetail | null => {
    const tokens = control.autocomplete;
    if (tokens.indexOf("cc-exp") >= 0) return "exp";
    if (tokens.indexOf("cc-exp-month") >= 0) return "exp_month";
    if (tokens.indexOf("cc-exp-year") >= 0) return "exp_year";
    if (tokens.indexOf("cc-name") >= 0) return "name";
    let expiry = false;
    let month = false;
    let year = false;
    let name = false;
    let holder = false;
    let notExpiry = false;
    let notHolder = false;
    for (const phrase of control.phrases)
      for (const word of phrase) {
        if (NOT_EXPIRY.indexOf(word) >= 0) notExpiry = true;
        if (NOT_HOLDER.indexOf(word) >= 0) notHolder = true;
        const exp =
          /exp(?:iry|iration|ires?|ire)?(month|mm|mon|year|yy|yyyy|yr|date|dt)?$/.exec(
            word
          );
        if (exp != null || word.indexOf("expir") >= 0) {
          expiry = true;
          const tail = exp != null ? (exp[1] ?? "") : "";
          if (tail === "month" || tail === "mm" || tail === "mon") month = true;
          if (
            tail === "year" ||
            tail === "yy" ||
            tail === "yyyy" ||
            tail === "yr"
          )
            year = true;
        }
        if (word === "valid" || word === "validthru" || word === "thru")
          expiry = true;
        if (word === "month" || word === "mm" || word === "mon") month = true;
        if (
          word === "year" ||
          word === "years" ||
          word === "yy" ||
          word === "yyyy" ||
          word === "yr"
        )
          year = true;
        if (word === "cardholder" || word === "holder" || word === "nameoncard")
          holder = true;
        if (word === "name") name = true;
      }
    if (!notExpiry && (expiry || month || year)) {
      if (month && year) return "exp";
      if (month) return "exp_month";
      if (year) return "exp_year";
      return "exp";
    }
    if (holder || (name && !notHolder)) return "name";
    return null;
  };
  const notBeside = (control: CardControl): boolean => {
    for (const phrase of control.phrases)
      for (const word of phrase) {
        if (NOT_BESIDE.indexOf(word) >= 0) return true;
        for (const other of NOT_BESIDE)
          if (word.indexOf(other) === 0) return true;
      }
    return false;
  };
  const tokenDetail = (control: CardControl): boolean =>
    control.autocomplete.some(
      (token) => token === "cc-name" || token.indexOf("cc-exp") === 0
    );

  const count = controls.length;
  const number: boolean[] = [];
  // Each fillable control's place among its form's fillable controls.
  const place: number[] = [];
  const placesInForm = new Map<number, number>();
  const groupsWithNumber = new Set<number>();
  for (let i = 0; i < count; i++) {
    const control = controls[i]!;
    const isNumber = control.fillable && numberish(control);
    number.push(isNumber);
    if (isNumber && control.group !== 0) groupsWithNumber.add(control.group);
    if (control.fillable) {
      const at = placesInForm.get(control.form) ?? 0;
      place.push(at);
      placesInForm.set(control.form, at + 1);
    } else place.push(-1);
  }
  // The nearest number field's place before and after each control, per form.
  const before: number[] = Array.from({ length: count }, () => -Infinity);
  const after: number[] = Array.from({ length: count }, () => Infinity);
  const lastSeen = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const control = controls[i]!;
    if (!control.fillable) continue;
    before[i] = lastSeen.get(control.form) ?? -Infinity;
    if (number[i]) lastSeen.set(control.form, place[i]!);
  }
  const nextSeen = new Map<number, number>();
  for (let i = count - 1; i >= 0; i--) {
    const control = controls[i]!;
    if (!control.fillable) continue;
    after[i] = nextSeen.get(control.form) ?? Infinity;
    if (number[i]) nextSeen.set(control.form, place[i]!);
  }
  const classes: CardClass[] = [];
  for (let i = 0; i < count; i++) {
    const control = controls[i]!;
    const words = control.fillable ? detailOf(control) : null;
    let detail: CardDetail | null = null;
    if (words != null && !number[i]) {
      if (tokenDetail(control)) detail = words;
      else if (!notBeside(control)) {
        const near =
          place[i]! - before[i]! <= 3 ||
          after[i]! - place[i]! <= 3 ||
          (control.group !== 0 && groupsWithNumber.has(control.group));
        if (near) detail = words;
      }
    }
    classes.push({ number: number[i]!, detailWords: words, detail });
  }
  return classes;
}
