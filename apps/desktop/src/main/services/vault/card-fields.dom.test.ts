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
} from "./vault-fill";

/** The document as CDP's DOM.getDocument gives it, with each node's element. */
const dump = (): { root: DomNode; elements: Map<number, Element> } => {
  let next = 1;
  const elements = new Map<number, Element>();
  const node = (el: Element): DomNode => {
    const id = next++;
    elements.set(id, el);
    const attributes: string[] = [];
    for (const attribute of Array.from(el.attributes))
      attributes.push(attribute.name, attribute.value);
    return {
      backendNodeId: id,
      nodeName: el.nodeName,
      attributes,
      children: Array.from(el.children).map(node),
    };
  };
  return { root: node(document.documentElement), elements };
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
