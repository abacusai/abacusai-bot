/**
 * Which of a document's fields are card fields, decided by structure as much
 * as by words. One function for the host (over the DOM it records at first
 * sighting) and for the Pay guard's page script (over the live DOM): the
 * page script embeds these functions' own source, so there is no second copy.
 *
 * - A card number or CVV: a `cc-number` / `cc-csc` token, or the field's own
 *   words naming one ("Card number", "cardNumber", "CVV", "Card CID",
 *   "Credit card or bank account number"). A "card" a word qualifies as
 *   another kind (gift, loyalty, rail, membership, ID, PAN, frequent flyer,
 *   residence, green, driver, senior citizen, ration, voter, health,
 *   insurance…) does not count, nor does an Aadhaar field, nor a bare "cid"
 *   (a customer id). A travel card is a prepaid payment card, so "Travel
 *   card number" counts.
 * - An expiry or cardholder name: a `cc-exp*` / `cc-name` token, or its
 *   words naming one AND a qualifying number or CVV field beside it: in the
 *   same fieldset or group, or within three fields of it in the same form
 *   and the same group. Card words in its own name are not enough. Passport,
 *   visa (the document, not the card brand), ticket or document wording in
 *   its words or its group's label never counts as beside. A bare "name"
 *   is the holder's only inside the card number's own group, and a
 *   passenger's, guest's, contact's or customer's name never is.
 *
 * The host reads naming attributes and a fieldset's legend from a DOM dump;
 * the page also reads `<label>` text, which the dump does not carry. The
 * cases here do not depend on label text alone.
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
  /** That group's own label (a fieldset's legend, a group's aria-label), as phrases. */
  groupPhrases: string[][];
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
    "aadhaar",
    "aadhar",
    "sim",
    "business",
    "visiting",
    "report",
    "flyer",
    "flier",
    "residence",
    "green",
    "driver",
    "drivers",
    "driving",
    "senior",
    "citizen",
    "pan",
  ];
  const NUMBER_WORDS = ["number", "num", "no", "nr", "nbr"];
  const CVV_WORDS = ["cvv", "cvv2", "cvc", "cvc2", "csc", "cvn"];
  const BRANDS = [
    "card",
    "credit",
    "debit",
    "mastercard",
    "amex",
    "rupay",
    "maestro",
    "discover",
    "diners",
    "jcb",
    "unionpay",
  ];
  const DOCUMENTS = ["passport", "ticket", "document", "documents"];
  const VISA_DOCUMENT = ["number", "no", "type", "expiry", "exp", "expiration"];
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
    "passenger",
    "guest",
    "contact",
    "traveller",
    "traveler",
    "lead",
    "customer",
    "emergency",
    "nominee",
  ];
  const has = (list: string[], word: string): boolean =>
    list.indexOf(word) >= 0;
  /** A word, or a joined prefix ("frequentflyer"), that makes "card" another kind. */
  const otherCard = (word: string): boolean => {
    if (has(OTHER_CARD, word)) return true;
    for (const other of OTHER_CARD) {
      if (word.indexOf(other + "card") === 0) return true;
      // Long qualifiers only, so "prepaid" does not end in "id".
      if (
        other.length >= 4 &&
        word.length > other.length &&
        word.slice(-other.length) === other
      )
        return true;
    }
    return false;
  };
  const aadhaar = (control: CardControl): boolean => {
    for (const phrase of control.phrases)
      for (const word of phrase)
        if (word === "aadhaar" || word === "aadhar") return true;
    return false;
  };
  const numberish = (control: CardControl): boolean => {
    const tokens = control.autocomplete;
    if (has(tokens, "cc-number") || has(tokens, "cc-csc")) return true;
    if (aadhaar(control)) return false;
    for (const phrase of control.phrases) {
      for (let i = 0; i < phrase.length; i++) {
        const word = phrase[i]!;
        const before = i > 0 ? phrase[i - 1]! : "";
        const after = i + 1 < phrase.length ? phrase[i + 1]! : "";
        if (has(CVV_WORDS, word)) return true;
        if (/^(?:cvv|cvc)[a-z0-9]*$/.test(word)) return true;
        // "cid" is a card's code only beside card or security words ("Card CID"), else a customer id.
        if (
          word === "cid" &&
          (before === "card" ||
            before === "security" ||
            after === "card" ||
            after === "security" ||
            after === "code")
        )
          return true;
        // "card number", "cc no"; not "gift card number" or "PAN card number".
        if (
          (word === "card" || word === "cc") &&
          has(NUMBER_WORDS, after) &&
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
          has(NUMBER_WORDS, after) &&
          !otherCard(word) &&
          !otherCard(before)
        )
          return true;
      }
    }
    return false;
  };
  /** What the words name, and whether a bare "name" is all that names a holder. */
  const detailOf = (
    control: CardControl
  ): { detail: CardDetail | null; bareName: boolean } => {
    const tokens = control.autocomplete;
    if (has(tokens, "cc-exp")) return { detail: "exp", bareName: false };
    if (has(tokens, "cc-exp-month"))
      return { detail: "exp_month", bareName: false };
    if (has(tokens, "cc-exp-year"))
      return { detail: "exp_year", bareName: false };
    if (has(tokens, "cc-name")) return { detail: "name", bareName: false };
    let expiry = false;
    let month = false;
    let year = false;
    let name = false;
    let holder = false;
    let cardWord = false;
    let notExpiry = false;
    let notHolder = false;
    for (const phrase of control.phrases)
      for (const word of phrase) {
        if (has(NOT_EXPIRY, word)) notExpiry = true;
        if (has(NOT_HOLDER, word)) notHolder = true;
        if (has(BRANDS, word) || word === "visa") cardWord = true;
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
      const detail: CardDetail =
        month && year ? "exp" : month ? "exp_month" : year ? "exp_year" : "exp";
      return { detail, bareName: false };
    }
    if (notHolder) return { detail: null, bareName: false };
    if (holder || (name && cardWord))
      return { detail: "name", bareName: false };
    if (name) return { detail: "name", bareName: true };
    return { detail: null, bareName: false };
  };
  /** Phrases that name a passport, visa, ticket or document. */
  const documentWording = (phrases: string[][]): boolean => {
    for (const phrase of phrases) {
      let brand = false;
      for (const word of phrase) if (has(BRANDS, word)) brand = true;
      for (let i = 0; i < phrase.length; i++) {
        const word = phrase[i]!;
        if (has(DOCUMENTS, word)) return true;
        for (const other of DOCUMENTS)
          if (word.indexOf(other) === 0) return true;
        // Visa the document: beside passport, or "visa number/type/expiry"
        // with no card brand in the same words ("Expiry (Visa/Mastercard)").
        const visa = word === "visa" || word.indexOf("visa") === 0;
        if (!visa || brand) continue;
        const rest = word === "visa" ? (phrase[i + 1] ?? "") : word.slice(4);
        if (word === "visa" && phrase.length === 1) continue;
        if (has(VISA_DOCUMENT, rest) || rest.indexOf("exp") === 0) return true;
      }
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
  // The nearest number field before and after each control, per form: its
  // place and its group.
  const nearBefore: Array<{ place: number; group: number } | null> = [];
  const nearAfter: Array<{ place: number; group: number } | null> = [];
  const lastSeen = new Map<number, { place: number; group: number }>();
  for (let i = 0; i < count; i++) {
    const control = controls[i]!;
    nearBefore.push(
      control.fillable ? (lastSeen.get(control.form) ?? null) : null
    );
    if (number[i])
      lastSeen.set(control.form, { place: place[i]!, group: control.group });
  }
  const nextSeen = new Map<number, { place: number; group: number }>();
  for (let i = count - 1; i >= 0; i--) {
    const control = controls[i]!;
    nearAfter[i] = control.fillable
      ? (nextSeen.get(control.form) ?? null)
      : null;
    if (number[i])
      nextSeen.set(control.form, { place: place[i]!, group: control.group });
  }
  const classes: CardClass[] = [];
  for (let i = 0; i < count; i++) {
    const control = controls[i]!;
    const found = control.fillable
      ? detailOf(control)
      : { detail: null, bareName: false };
    let detail: CardDetail | null = null;
    if (found.detail != null && !number[i]) {
      if (tokenDetail(control)) detail = found.detail;
      else if (
        !documentWording(control.phrases) &&
        !documentWording(control.groupPhrases)
      ) {
        const inCardGroup =
          control.group !== 0 && groupsWithNumber.has(control.group);
        // Within three fields, and never across groups.
        const close = (
          near: { place: number; group: number } | null
        ): boolean =>
          near != null &&
          Math.abs(place[i]! - near.place) <= 3 &&
          near.group === control.group;
        const beside =
          inCardGroup || close(nearBefore[i]!) || close(nearAfter[i]!);
        // A bare "name" is the holder's only inside the card's own group.
        if (found.bareName ? inCardGroup : beside) detail = found.detail;
      }
    }
    classes.push({ number: number[i]!, detailWords: found.detail, detail });
  }
  return classes;
}
