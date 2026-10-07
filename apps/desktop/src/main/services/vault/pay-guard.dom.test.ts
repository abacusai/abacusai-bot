// @vitest-environment jsdom
/**
 * The Pay guard's page script, actually run against a DOM: what it reads of a
 * control decides whether a payment can slip through, so a scripted reply
 * proves nothing about it.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { type ControlFacts, controlFactsScript } from "./pay-guard";

/** Runs the script as the page would, in the global scope, and returns its value. */
const read = (
  selector: string | null,
  options: { enter?: boolean; option?: string } = {}
): ControlFacts =>
  Function(`return ${controlFactsScript(selector, options)}`)() as ControlFacts;

beforeEach(() => {
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/checkout/payment");
});

describe("what the guard reads of a page", () => {
  it("takes Enter in a card field as its form's submitter, found through form.elements", () => {
    document.body.innerHTML = `
      <form id="f"><input name="cardnumber" id="cc"></form>
      <button type="submit" form="f" id="pay">Pay ₹1,234</button>`;
    (document.getElementById("cc") as HTMLInputElement).focus();
    const facts = read(null, { enter: true });
    expect(facts.kind).toBe("submit");
    expect(facts.label).toMatch(/Pay/);
    expect(facts.submitsCardForm).toBe(true);
    expect(facts.cardFields).toBe(true);
  });

  it("sees a card the site saved, already selected", () => {
    document.body.innerHTML = `
      <input type="radio" name="pm" id="saved" checked><label for="saved">Visa •••• 4242</label>
      <button id="pay">Pay</button>`;
    expect(read("#pay").savedCardSelected).toBe(true);
  });

  it("sees a provider's card frame, or a frame that says it takes payment, with no card inputs on the page", () => {
    document.body.innerHTML = `<iframe src="https://js.stripe.com/v3/elements"></iframe><button id="go">Continue</button>`;
    expect(read("#go")).toMatchObject({
      paymentFrame: true,
      cardFields: false,
    });
    document.body.innerHTML = `<iframe title="Secure payment form" src="https://pay.bank.example/x"></iframe><button id="go">Continue</button>`;
    expect(read("#go").paymentFrame).toBe(true);
  });

  it("names a card-method section, a save-card box and a radio by what they are", () => {
    document.body.innerHTML = `
      <div role="tab" aria-controls="card" id="tab">Credit / Debit Card</div>
      <label><input type="checkbox" id="save"> Save this card for faster checkout</label>
      <label><input type="radio" id="upi" value="upi"> UPI</label>`;
    expect(read("#tab").kind).toBe("card-method");
    expect(read("#save")).toMatchObject({ kind: "checkbox", checked: false });
    expect(read("#save").label).toMatch(/Save this card/);
    expect(read("#upi")).toMatchObject({ kind: "radio" });
    expect(`${read("#upi").label} ${read("#upi").attrs}`).toMatch(/upi/i);
  });

  it("reports the focus inside a frame as a frame, and whose it is", () => {
    document.body.innerHTML = `<iframe id="f" src="https://js.stripe.com/v3"></iframe>`;
    (document.getElementById("f") as HTMLIFrameElement).focus();
    expect(read(null, { enter: true })).toMatchObject({
      kind: "frame",
      frameIsProvider: true,
    });
  });

  it("sees a card shown by its last digits, and a price, anywhere on the page", () => {
    document.body.innerHTML = `<p>Visa •••• 4242</p> <p>Total ₹1,234.00</p> <button id="go">Go</button>`;
    expect(read("#go")).toMatchObject({
      maskedCardOnPage: true,
      priceOnPage: true,
    });
    document.body.innerHTML = `<p>Flights from Mumbai</p><button id="go">Go</button>`;
    expect(read("#go")).toMatchObject({
      maskedCardOnPage: false,
      priceOnPage: false,
    });
  });

  it("sees any control on the page that would buy, by its words or attributes", () => {
    document.body.innerHTML = `<p>Mug</p> <button id="buy">Buy now</button> <a id="go" href="/more">More</a>`;
    expect(read("#go").commitControlOnPage).toBe(true);
    document.body.innerHTML = `<a id="x" class="btn-pay" href="#">→</a> <a id="go" href="/more">More</a>`;
    expect(read("#go").commitControlOnPage).toBe(true);
    document.body.innerHTML = `<button id="go">Search</button> <a href="/help">Help</a>`;
    expect(read("#go").commitControlOnPage).toBe(false);
  });

  it("says when nothing matched", () => {
    expect(read("#missing").found).toBe(false);
  });
});
