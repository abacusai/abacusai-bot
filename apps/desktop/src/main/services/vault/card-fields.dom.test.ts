// @vitest-environment jsdom
/**
 * The card rule over real documents, read the two ways it is read: by the
 * host from a DOM dump, and by the page script live. Both must agree, and
 * both must match what the field is.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  controlFactsScript,
  looksLikePaymentStep,
  type ControlFacts,
} from "./pay-guard";
import {
  type DomNode,
  FIELD_FACTS_JS,
  type FieldFacts,
  factsFromDocument,
  cardField,
  fieldKindAllowed,
  type FillKind,
} from "./vault-fill";

/** The document as CDP's DOM.getDocument gives it, with each node's element. */
const dump = (): { root: DomNode; elements: Map<number, Element> } => {
  let next = 1;
  const elements = new Map<number, Element>();
  const node = (child: Node): DomNode | null => {
    if (child.nodeType === 3)
      return { nodeName: "#text", nodeValue: child.nodeValue ?? "" };
    if (child.nodeType !== 1) return null;
    const el = child as Element;
    const id = next++;
    elements.set(id, el);
    const attributes: string[] = [];
    for (const attribute of Array.from(el.attributes))
      attributes.push(attribute.name, attribute.value);
    return {
      backendNodeId: id,
      nodeName: el.nodeName,
      attributes,
      children: Array.from(el.childNodes)
        .map(node)
        .filter((each): each is DomNode => each != null),
    };
  };
  return { root: node(document.documentElement)!, elements };
};

/** The live facts of every input, as the page script reads them. */
const live = (): Map<Element, FieldFacts> =>
  Function(`${FIELD_FACTS_JS}; return __documentFacts(document);`)() as Map<
    Element,
    FieldFacts
  >;

/** What the card rule makes of the element `selector` names: host and page must agree. */
const classOf = (selector: string) => {
  const el = document.querySelector(selector)!;
  const { root, elements } = dump();
  const hostFacts = factsFromDocument(root);
  const id = [...elements].find(([, each]) => each === el)![0];
  const host = hostFacts.get(id)!;
  const page = live().get(el)!;
  // Labels are read live only; they decide nothing these cases rely on.
  expect(page.card, selector).toEqual(host.card);
  return host.card;
};

const isCard = (selector: string): boolean => {
  const el = document.querySelector(selector)!;
  return cardField(live().get(el)!);
};

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("a card number or CVV", () => {
  it("is named by the field's own words, however they are written", () => {
    for (const field of [
      '<input name="cardNumber" id="input-id-12">',
      '<input id="card-number-id">',
      '<input name="cvv-id">',
      '<input aria-label="Credit card or bank account number">',
      '<input placeholder="Travel card number">',
      '<input name="creditcardnumber">',
      '<input name="paymentCardNumber">',
      '<input name="cardCvv">',
      '<input aria-label="Prepaid card number">',
      '<input id="input-id-12" name="cardNumber">',
      '<input autocomplete="cc-number" name="x">',
    ]) {
      document.body.innerHTML = `<form>${field}</form>`;
      expect(classOf("input").number, field).toBe(true);
    }
  });

  it("is not a card some other word qualifies, nor a PAN or Aadhaar", () => {
    for (const field of [
      '<input name="pan" placeholder="PAN">',
      '<input aria-label="PAN card number">',
      '<input aria-label="Aadhaar number">',
      '<input aria-label="Loyalty card number">',
      '<input aria-label="Gift card number">',
      '<input placeholder="Railcard number">',
      '<input aria-label="Membership number">',
      '<input aria-label="ID card number">',
      '<input aria-label="Library card no">',
      '<input name="accNo" aria-label="Account number">',
      '<input name="ccEmail">',
    ]) {
      document.body.innerHTML = `<form>${field}</form>`;
      expect(classOf("input"), field).toEqual({
        number: false,
        detailWords: null,
        detail: null,
      });
    }
  });

  it("never makes a page with a PAN or Aadhaar field a payment step", () => {
    window.history.replaceState({}, "", "/kyc");
    document.body.innerHTML = `<form><input aria-label="PAN card number"><input aria-label="Aadhaar number">
      <button type="submit" id="go">Continue</button></form>`;
    const facts = Function(
      `return ${controlFactsScript("#go")}`
    )() as ControlFacts;
    expect(facts.cardFields).toBe(false);
    expect(looksLikePaymentStep(facts)).toBe(false);
  });
});

describe("a card expiry or name", () => {
  /** A booking form: a passport section, then the card section. */
  const booking = (passport: string, card = "") => `
    <form>
      <fieldset><legend>Traveller</legend>${passport}
        <input name="pax0_first" aria-label="First name">
        <input name="pax0_last" aria-label="Last name">
        <input name="pax0_email" type="email">
        <input name="pax0_phone" type="tel">
      </fieldset>
      <fieldset><legend>Payment</legend>
        <input id="number" autocomplete="off" name="cardNumber">
        <input id="exp" placeholder="MM/YY">
        <input id="holder" aria-label="Name on card">
        <input id="cvc" name="cvc">${card}
      </fieldset>
    </form>`;

  it("counts only beside a card number or CVV, in its group or within three fields", () => {
    document.body.innerHTML = booking("");
    expect(classOf("#exp").detail).toBe("exp");
    expect(classOf("#holder").detail).toBe("name");
  });

  it("is never a passport's, a visa's or a ticket's, even in a form with a card", () => {
    for (const field of [
      '<input id="t" name="pax0_exp">',
      '<input id="t" name="ppExp">',
      '<input id="t" name="visaExpiry">',
      '<select id="t" name="pp_exp_month"><option>01</option></select>',
      '<input id="t" aria-label="Ticket holder name">',
    ]) {
      document.body.innerHTML = booking(field);
      expect(classOf("#t").detail, field).toBeNull();
      expect(isCard("#t"), field).toBe(false);
    }
  });

  it("counts a field with no document wording when it sits in the card's group", () => {
    document.body.innerHTML = booking("", '<input id="t" name="pax0_exp">');
    expect(classOf("#t").detail).toBe("exp");
  });

  it("is vetoed by passport, visa or ticket wording even right beside the card", () => {
    for (const field of [
      '<input id="t" name="visaExpiry">',
      '<input id="t" aria-label="Passport expiry date">',
      '<input id="t" aria-label="Ticket holder name">',
    ]) {
      document.body.innerHTML = booking("", field);
      expect(classOf("#t").detail, field).toBeNull();
    }
  });

  it("is not made one by card words in its own name alone", () => {
    document.body.innerHTML = `<form><input id="t" name="cardExpiry"><input name="cardholderName"></form>`;
    expect(classOf("#t").detail).toBeNull();
    expect(isCard("#t")).toBe(false);
  });

  it("counts by a cc-exp or cc-name token wherever it is", () => {
    document.body.innerHTML = `<form><select id="t" autocomplete="cc-exp-month"><option>01</option></select>
      <input id="n" autocomplete="cc-name"></form>`;
    expect(classOf("#t").detail).toBe("exp_month");
    expect(classOf("#n").detail).toBe("name");
  });

  it("follows el.form: a field outside the form element that names it by id is in it", () => {
    document.body.innerHTML = `<form id="pay"><input name="cardNumber"></form>
      <input id="t" form="pay" placeholder="MM/YY">
      <input id="u" placeholder="MM/YY">`;
    expect(classOf("#t").detail).toBe("exp");
    // In no form at all, the document is its form: the card number is in another.
    expect(classOf("#u").detail).toBeNull();
  });
});

describe("reading a large page", () => {
  it("reads 500 checkboxes and a card form in well under the time a call has", () => {
    window.history.replaceState({}, "", "/checkout/payment");
    document.body.innerHTML = `<form>${'<input type="checkbox">'.repeat(500)}
      <input name="cardNumber"><button type="submit" id="go">Pay</button></form>`;
    const started = performance.now();
    const facts = Function(
      `return ${controlFactsScript("#go")}`
    )() as ControlFacts;
    expect(performance.now() - started).toBeLessThan(200);
    expect(facts.cardFields).toBe(true);
  });

  it("classifies 500 text fields in one pass, on the host and in the page", () => {
    document.body.innerHTML = `<form>${'<input type="text" name="f">'.repeat(499)}<input name="cardNumber"></form>`;
    const started = performance.now();
    factsFromDocument(dump().root);
    live();
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("the review's probes", () => {
  /** A checkout form: the card's group, then whatever follows it. */
  const checkout = (after: string, cardExtra = "") => `
    <form>
      <fieldset><legend>Card</legend>
        <input name="cardNumber">
        <input id="exp" placeholder="MM/YY">
        <input name="cvc">${cardExtra}
      </fieldset>
      ${after}
    </form>`;

  it("refuses a passport expiry in its own fieldset right after the CVV", () => {
    document.body.innerHTML = checkout(
      '<fieldset><legend>Passport</legend><input id="t" name="pp_exp"></fieldset>'
    );
    expect(classOf("#t").detail).toBeNull();
    // An unlabelled group after the card is still another group.
    document.body.innerHTML = checkout(
      '<fieldset><input id="t" name="pp_exp"></fieldset>'
    );
    expect(classOf("#t").detail).toBeNull();
    // A Passport legend vetoes even a field with no document words.
    document.body.innerHTML = `<form><fieldset><legend>Passport details</legend>
      <input name="cardNumber"><input id="t" name="exp"></fieldset></form>`;
    expect(classOf("#t").detail).toBeNull();
  });

  it("refuses a passenger's, guest's or contact's name after the CVV", () => {
    for (const field of [
      '<input id="t" aria-label="Passenger name">',
      '<input id="t" aria-label="Guest name">',
      '<input id="t" aria-label="Contact name">',
      '<input id="t" name="name">',
    ]) {
      document.body.innerHTML = checkout(field);
      expect(classOf("#t").detail, field).toBeNull();
    }
    // A bare "name" inside the card's own group is the holder's.
    document.body.innerHTML = checkout("", '<input id="t" name="name">');
    expect(classOf("#t").detail).toBe("name");
    // Guest or contact names in the card's group are not.
    document.body.innerHTML = checkout(
      "",
      '<input id="t" aria-label="Guest name">'
    );
    expect(classOf("#t").detail).toBeNull();
  });

  it("accepts a real card form whose expiry names the card brands", () => {
    document.body.innerHTML = checkout(
      "",
      '<input id="t" aria-label="Expiry (Visa/Mastercard)">'
    );
    expect(classOf("#t").detail).toBe("exp");
    document.body.innerHTML = `<form><input name="cardNumber">
      <input id="t" placeholder="Visa card expiry"></form>`;
    expect(classOf("#t").detail).toBe("exp");
    // The visa document is still refused.
    for (const field of [
      '<input id="t" aria-label="Visa expiry">',
      '<input id="t" aria-label="Visa number">',
      '<input id="t" name="visaType">',
    ]) {
      document.body.innerHTML = `<form><input name="cardNumber">${field}</form>`;
      expect(classOf("#t").detail, field).toBeNull();
    }
  });

  it("does not take a customer id for a card code", () => {
    window.history.replaceState({}, "", "/login");
    document.body.innerHTML = `<form><input id="t" name="cid" aria-label="Customer ID">
      <input type="password"><button type="submit" id="go">Sign in</button></form>`;
    expect(classOf("#t").number).toBe(false);
    const facts = Function(
      `return ${controlFactsScript("#go")}`
    )() as ControlFacts;
    expect(looksLikePaymentStep(facts)).toBe(false);
    document.body.innerHTML =
      '<form><input id="t" aria-label="Card CID"></form>';
    expect(classOf("#t").number).toBe(true);
  });

  it("vetoes PAN only as a card: a field named pan for a card number counts", () => {
    document.body.innerHTML =
      '<form><input id="t" name="pan" aria-label="Card number"></form>';
    expect(classOf("#t").number).toBe(true);
    document.body.innerHTML =
      '<form><input id="t" aria-label="PAN card number"></form>';
    expect(classOf("#t").number).toBe(false);
  });

  it("does not count the other cards a wallet may hold", () => {
    for (const label of [
      "Frequent flyer card number",
      "Residence card number",
      "Green card number",
      "Driver card number",
      "Senior citizen card number",
      "Ration card number",
      "Voter card number",
      "Health card number",
      "Insurance card number",
    ]) {
      document.body.innerHTML = `<form><input id="t" aria-label="${label}"></form>`;
      expect(classOf("#t").number, label).toBe(false);
    }
  });
});

describe("a fill of the card's expiry or name", () => {
  /** Whether the vault may fill `kind` into the element `selector` names, host and page alike. */
  const takes = (kind: FillKind, selector: string): boolean => {
    const el = document.querySelector(selector)!;
    const { root, elements } = dump();
    const id = [...elements].find(([, each]) => each === el)![0];
    const host = fieldKindAllowed(
      kind,
      factsFromDocument(root).get(id)!,
      false
    );
    const page = fieldKindAllowed(kind, live().get(el)!, false);
    expect(page, selector).toBe(host);
    return host;
  };

  it("goes into the card section's fields, never the passport section's", () => {
    document.body.innerHTML = `
      <form>
        <fieldset><legend>Passport</legend>
          <select id="pp-month" name="pp_exp_month"><option>01</option></select>
          <select id="pp-year" name="pp_exp_year"><option>2030</option></select>
          <input id="pax-exp" name="pax0_exp" placeholder="MM/YY">
          <input id="visa" name="visaExpiry">
          <input id="ticket" aria-label="Ticket holder name">
          <input name="pax0_first"><input name="pax0_last"><input name="pax0_email">
        </fieldset>
        <fieldset><legend>Card</legend>
          <input name="cardNumber">
          <select id="month" name="expMonth"><option>01</option></select>
          <select id="year" name="expYear"><option>2030</option></select>
          <input id="holder" aria-label="Name on card">
        </fieldset>
      </form>`;
    expect(takes("card_exp_month", "#month")).toBe(true);
    expect(takes("card_exp_year", "#year")).toBe(true);
    expect(takes("cardholder_name", "#holder")).toBe(true);
    expect(takes("card_exp_month", "#pp-month")).toBe(false);
    expect(takes("card_exp_year", "#pp-year")).toBe(false);
    expect(takes("card_exp", "#pax-exp")).toBe(false);
    expect(takes("card_exp", "#visa")).toBe(false);
    expect(takes("cardholder_name", "#ticket")).toBe(false);
  });

  it("refuses the review's probes and takes the real card form", () => {
    const card = (after: string, extra = "") => `<form>
      <fieldset><legend>Card</legend><input name="cardNumber">${extra}<input name="cvc"></fieldset>
      ${after}</form>`;
    document.body.innerHTML = card(
      '<fieldset><legend>Passport</legend><input id="t" name="pp_exp" placeholder="MM/YY"></fieldset>'
    );
    expect(takes("card_exp", "#t")).toBe(false);
    document.body.innerHTML = card(
      '<input id="t" aria-label="Passenger name">'
    );
    expect(takes("cardholder_name", "#t")).toBe(false);
    document.body.innerHTML = card(
      "",
      '<input id="g" aria-label="Guest name"><input id="c" aria-label="Contact name">'
    );
    expect(takes("cardholder_name", "#g")).toBe(false);
    expect(takes("cardholder_name", "#c")).toBe(false);
    document.body.innerHTML = card(
      "",
      '<input id="t" aria-label="Expiry (Visa/Mastercard)"><input id="h" aria-label="Name on card">'
    );
    expect(takes("card_exp", "#t")).toBe(true);
    expect(takes("cardholder_name", "#h")).toBe(true);
  });

  it("takes nothing named an expiry or holder with no card number beside it", () => {
    for (const [kind, field] of [
      ["card_exp", '<input id="t" placeholder="Travel date MM/YY">'],
      [
        "card_exp_year",
        '<input id="t" name="exp_years" aria-label="Years of experience">',
      ],
      ["cardholder_name", '<input id="t" aria-label="Policy holder name">'],
      ["cardholder_name", '<input id="t" aria-label="Account holder name">'],
      ["cardholder_name", '<input id="t" aria-label="Passport holder name">'],
      ["card_exp", '<input id="t" name="cardExpiry">'],
    ] as const) {
      document.body.innerHTML = `<form>${field}<input name="email" type="email"></form>`;
      expect(takes(kind, "#t"), field).toBe(false);
    }
  });
});
