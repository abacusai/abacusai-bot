import { describe, expect, it } from "vitest";

import type { VaultField } from "./vault-client";
import {
  codeFieldAllowed,
  factsFromDocument,
  hasCodeField,
  fieldKindAllowed,
  LIVE_FIELD_FUNCTION,
  type FieldFacts,
  isPaymentFrameOrigin,
  planFill,
  readPageTotal,
  sameAmount,
  type FillContext,
} from "./vault-fill";
import type { PaymentApproval, SigninApproval } from "./vault-session";

const approval = (
  overrides: Partial<PaymentApproval> = {}
): PaymentApproval => ({
  id: "pay-1",
  item: "card-1",
  merchant: "Akasa Air",
  amount: "1234.00",
  currency: "INR",
  site: "akasaair.com",
  cvvRequired: true,
  status: "approved",
  used: new Set(),
  codeOrigin: null,
  expiresAt: Date.now() + 60_000,
  ...overrides,
});

const signin = (overrides: Partial<SigninApproval> = {}): SigninApproval => ({
  id: "signin-1",
  item: "login-1",
  site: "example.com",
  status: "approved",
  used: new Set(),
  expiresAt: Date.now() + 60_000,
  ...overrides,
});

const context = (overrides: Partial<FillContext>): FillContext => ({
  itemId: "card-1",
  field: "card_number",
  topOrigin: "https://www.akasaair.com",
  frameOrigin: null,
  inFrame: false,
  approval: approval(),
  signin: null,
  pageTotal: readPageTotal("Total ₹1,234.00"),
  ...overrides,
});

/** A login field on the login's own site, under the sign-in the user allowed. */
const loginContext = (overrides: Partial<FillContext> = {}): FillContext =>
  context({
    itemId: "login-1",
    field: "password",
    topOrigin: "https://www.example.com",
    approval: null,
    signin: signin(),
    pageTotal: null,
    ...overrides,
  });

describe("which frames may receive a card or code", () => {
  it("takes the payment providers' frames and their subdomains, over https only", () => {
    expect(isPaymentFrameOrigin("https://js.stripe.com")).toBe(true);
    expect(isPaymentFrameOrigin("https://checkoutshopper-live.adyen.com")).toBe(
      true
    );
    expect(isPaymentFrameOrigin("https://api.razorpay.com")).toBe(true);
    expect(isPaymentFrameOrigin("http://js.stripe.com")).toBe(false);
    expect(isPaymentFrameOrigin("https://stripe.com.evil.example")).toBe(false);
    expect(isPaymentFrameOrigin("https://evilstripe.com")).toBe(false);
    expect(isPaymentFrameOrigin(null)).toBe(false);
  });

  it("refuses a card into a cross-origin frame that is not a provider's", () => {
    expect(
      planFill(context({ inFrame: true, frameOrigin: "https://ads.example" }))
        .ok
    ).toBe(false);
  });

  it("refuses a code into one too, and a frame whose origin could not be read", () => {
    expect(
      planFill(
        context({
          field: "code",
          itemId: "login-1",
          approval: null,
          topOrigin: "https://site.example",
          inFrame: true,
          frameOrigin: "https://widget.example",
        })
      ).ok
    ).toBe(false);
    expect(planFill(context({ inFrame: true, frameOrigin: null })).ok).toBe(
      false
    );
    expect(
      planFill(
        context({
          field: "password",
          itemId: "login-1",
          inFrame: true,
          frameOrigin: null,
        })
      ).ok
    ).toBe(false);
  });

  it("fills a card into a provider's frame under the page's origin, with the page's total", () => {
    expect(
      planFill(context({ inFrame: true, frameOrigin: "https://js.stripe.com" }))
    ).toEqual({
      ok: true,
      request: {
        origin: "https://www.akasaair.com",
        frameOrigin: "https://js.stripe.com",
        paymentApprovalId: "pay-1",
        amount: "1234.00",
        currency: "INR",
      },
      documentOrigin: "https://js.stripe.com",
      uses: new Set(),
    });
  });

  it("fills a login into a cross-origin frame under that frame's origin", () => {
    expect(
      planFill(
        loginContext({
          topOrigin: "https://shop.example.net",
          inFrame: true,
          frameOrigin: "https://login.example.com",
        })
      )
    ).toEqual({
      ok: true,
      request: {
        origin: "https://login.example.com",
        frameOrigin: "https://login.example.com",
        signinApprovalId: "signin-1",
      },
      documentOrigin: "https://login.example.com",
      uses: new Set(),
    });
  });
});

describe("a card fill", () => {
  it("sends the server the total the page shows, not the approval's own amount", () => {
    const plan = planFill(
      context({
        pageTotal: readPageTotal("₹1,234"),
        approval: approval({ amount: "1234.00" }),
      })
    );
    expect(plan.ok && plan.request.amount).toBe("1234");
  });

  it("is refused with no total read from the page", () => {
    const plan = planFill(context({ pageTotal: null }));
    expect(plan.ok).toBe(false);
    if (plan.ok === false) expect(plan.error).toContain("total_ref");
  });

  it("is refused when the page's total or currency is not the approved one", () => {
    const plan = planFill(context({ pageTotal: readPageTotal("₹1,334.00") }));
    expect(plan.ok).toBe(false);
    if (plan.ok === false) expect(plan.error).toContain("1234.00 INR");
    expect(
      planFill(context({ pageTotal: readPageTotal("$1,234.00") })).ok
    ).toBe(false);
    expect(planFill(context({ pageTotal: readPageTotal("1,234.00") })).ok).toBe(
      false
    );
  });

  it("is refused a second time for the same field under one approval", () => {
    const used = approval({ used: new Set(["card_number"]) });
    expect(planFill(context({ approval: used })).ok).toBe(false);
    expect(planFill(context({ approval: used, field: "cvv" })).ok).toBe(true);
  });

  it("is refused with no approval, another card, another site, no site or an unasked CVV", () => {
    expect(planFill(context({ approval: null })).ok).toBe(false);
    expect(planFill(context({ itemId: "card-2" })).ok).toBe(false);
    expect(
      planFill(context({ topOrigin: "https://akasaair.com.evil.example" })).ok
    ).toBe(false);
    expect(planFill(context({ approval: approval({ site: "" }) })).ok).toBe(
      false
    );
    expect(
      planFill(
        context({ field: "cvv", approval: approval({ cvvRequired: false }) })
      ).ok
    ).toBe(false);
  });

  it("is refused on a page that is not https, or whose origin could not be read", () => {
    expect(planFill(context({ topOrigin: "http://www.akasaair.com" })).ok).toBe(
      false
    );
    expect(planFill(context({ topOrigin: null })).ok).toBe(false);
  });
});

describe("a bank's code for the approved card", () => {
  it("goes into the bank's own frame on the checkout, when that is where it was asked for", () => {
    const plan = planFill(
      context({
        field: "code",
        inFrame: true,
        frameOrigin: "https://acs.bank.example",
        approval: approval({ codeOrigin: "https://acs.bank.example" }),
      })
    );
    expect(plan).toEqual({
      ok: true,
      request: {
        origin: "https://acs.bank.example",
        frameOrigin: "https://acs.bank.example",
        paymentApprovalId: "pay-1",
      },
      documentOrigin: "https://acs.bank.example",
      uses: null,
    });
  });

  it("goes into the bank's page when it replaced the checkout, when that is where it was asked for", () => {
    expect(
      planFill(
        context({
          field: "code",
          topOrigin: "https://secure.bank.example",
          approval: approval({ codeOrigin: "https://secure.bank.example" }),
        })
      )
    ).toMatchObject({
      ok: true,
      request: {
        origin: "https://secure.bank.example",
        paymentApprovalId: "pay-1",
      },
    });
  });

  it("goes nowhere else, nor before it was asked for, nor without a live approval", () => {
    const bound = approval({ codeOrigin: "https://acs.bank.example" });
    expect(
      planFill(
        context({
          field: "code",
          inFrame: true,
          frameOrigin: "https://other.example",
          approval: bound,
        })
      ).ok
    ).toBe(false);
    expect(
      planFill(
        context({
          field: "code",
          topOrigin: "https://acs.bank.example.evil.example",
          approval: bound,
        })
      ).ok
    ).toBe(false);
    expect(planFill(context({ field: "code", approval: approval() })).ok).toBe(
      false
    );
    // No approval: a code for this item is a login's, and a login code is
    // never typed into a frame that is not a payment provider's.
    expect(
      planFill(
        context({
          field: "code",
          approval: null,
          inFrame: true,
          frameOrigin: "https://acs.bank.example",
        })
      ).ok
    ).toBe(false);
  });

  it("leaves card fields bound to the merchant's page", () => {
    const bound = approval({ codeOrigin: "https://acs.bank.example" });
    expect(
      planFill(
        context({
          approval: bound,
          inFrame: true,
          frameOrigin: "https://acs.bank.example",
        })
      ).ok
    ).toBe(false);
  });
});

/** An input's facts, as `factsFromDocument` or the live check reads them. */
const facts = (overrides: Partial<FieldFacts> = {}): FieldFacts => ({
  tag: "input",
  type: "text",
  autocomplete: [],
  role: "",
  inputmode: "",
  enterkeyhint: "",
  pattern: "",
  maxLength: -1,
  wasPassword: false,
  adjacentPassword: false,
  hints: [],
  ...overrides,
});

const accepts = (
  field: VaultField,
  overrides: Partial<FieldFacts>,
  inPaymentFrame = false
): boolean => fieldKindAllowed(field, facts(overrides), inPaymentFrame);

describe("which fields take which value", () => {
  it("puts a password only into a field that is or was a password field", () => {
    expect(accepts("password", { type: "password", wasPassword: true })).toBe(
      true
    );
    expect(accepts("password", { type: "text", wasPassword: true })).toBe(true);
    expect(accepts("password", { type: "text" })).toBe(false);
    expect(accepts("password", { type: "search", wasPassword: true })).toBe(
      false
    );
    expect(accepts("password", { tag: "textarea", wasPassword: true })).toBe(
      false
    );
    expect(accepts("password", { tag: "div", wasPassword: true })).toBe(false);
  });

  it("puts a username only into a text or email field marked for it, or right next to the password", () => {
    expect(accepts("username", { type: "email", adjacentPassword: true })).toBe(
      true
    );
    expect(accepts("username", { autocomplete: ["username"] })).toBe(true);
    expect(
      accepts("username", { type: "email", autocomplete: ["email"] })
    ).toBe(true);
    // In the same form is not enough: a search box beside a login form.
    expect(accepts("username", { type: "text" })).toBe(false);
    expect(
      accepts("username", { type: "search", autocomplete: ["username"] })
    ).toBe(false);
    expect(
      accepts("username", { role: "searchbox", adjacentPassword: true })
    ).toBe(false);
    expect(
      accepts("username", { type: "tel", autocomplete: ["username"] })
    ).toBe(false);
  });

  it("puts card fields only into fields marked for them, or a payment provider's frame", () => {
    expect(accepts("card_number", { autocomplete: ["cc-number"] })).toBe(true);
    expect(accepts("cvv", { type: "tel", autocomplete: ["cc-csc"] })).toBe(
      true
    );
    expect(accepts("card_number", {})).toBe(false);
    expect(accepts("cvv", { autocomplete: ["cc-number"] })).toBe(false);
    expect(accepts("card_number", { type: "tel" }, true)).toBe(true);
    expect(accepts("card_number", { type: "search" }, true)).toBe(false);
  });

  it("puts a code only into a one-time-code field or a short numeric one", () => {
    expect(accepts("code", { autocomplete: ["one-time-code"] })).toBe(true);
    expect(accepts("code", { inputmode: "numeric", maxLength: 6 })).toBe(true);
    expect(accepts("code", { pattern: "\\d*", maxLength: 6 })).toBe(true);
    expect(accepts("code", { maxLength: 6 })).toBe(false);
    expect(accepts("code", { type: "tel" })).toBe(false);
    expect(
      accepts("code", { type: "search", autocomplete: ["one-time-code"] })
    ).toBe(false);
  });

  it("never puts a code into a postcode or PIN field that looks like a code field", () => {
    const short = { inputmode: "numeric", maxLength: 6 };
    expect(accepts("code", { ...short, hints: ["zip"] })).toBe(false);
    expect(accepts("code", { ...short, hints: ["postal", "code"] })).toBe(
      false
    );
    expect(accepts("code", { ...short, hints: ["pincode"] })).toBe(false);
    expect(accepts("code", { ...short, hints: ["enter", "pin"] })).toBe(false);
    expect(accepts("code", { ...short, autocomplete: ["postal-code"] })).toBe(
      false
    );
    expect(accepts("code", { ...short, hints: ["otp"] })).toBe(true);
  });

  it("puts an unmarked code only into the page's one and only code-like field", () => {
    const otp = facts({ inputmode: "numeric", maxLength: 6, hints: ["otp"] });
    const marked = facts({ autocomplete: ["one-time-code"] });
    const another = facts({ type: "tel", inputmode: "numeric", maxLength: 4 });

    expect(codeFieldAllowed(otp, [otp])).toBe(true);
    expect(codeFieldAllowed(otp, [otp, another])).toBe(false);
    expect(codeFieldAllowed(marked, [marked, otp, another])).toBe(true);
    expect(codeFieldAllowed(facts({}), [facts({})])).toBe(false);
  });

  it("finds a page's code field by the very rule a fill uses", () => {
    const otp = facts({ inputmode: "numeric", maxLength: 6 });
    const pin = facts({ inputmode: "numeric", maxLength: 4, hints: ["pin"] });
    const marked = facts({ autocomplete: ["one-time-code"] });

    expect(hasCodeField([otp, pin])).toBe(true);
    // Two unmarked code-like fields: a fill would refuse both, so no page is found.
    expect(hasCodeField([otp, facts({ type: "tel", maxLength: 6 })])).toBe(
      false
    );
    expect(hasCodeField([otp, otp, marked])).toBe(true);
    expect(hasCodeField([pin])).toBe(false);
  });
});

describe("an input's facts as first seen", () => {
  const input = (id: number, ...attributes: string[]) => ({
    nodeName: "INPUT",
    backendNodeId: id,
    attributes,
  });

  it("reads each input's declared kind, and whether the password is right next to it", () => {
    const read = factsFromDocument({
      nodeName: "#document",
      children: [
        {
          nodeName: "FORM",
          children: [
            input(1, "type", "search", "name", "q"),
            input(2, "type", "hidden"),
            input(3, "type", "email", "name", "email"),
            input(4, "type", "password", "autocomplete", "current-password"),
            input(5, "type", "checkbox"),
            input(6, "inputmode", "numeric", "maxlength", "6"),
            input(
              7,
              "name",
              "billing_zip",
              "inputmode",
              "numeric",
              "maxlength",
              "6"
            ),
          ],
        },
      ],
    });

    expect(read.get(1)).toMatchObject({
      type: "search",
      adjacentPassword: false,
    });
    expect(read.get(3)).toMatchObject({
      type: "email",
      adjacentPassword: true,
    });
    expect(read.get(4)).toMatchObject({
      wasPassword: true,
      autocomplete: ["current-password"],
    });
    expect(read.get(6)).toMatchObject({
      type: "text",
      inputmode: "numeric",
      maxLength: 6,
      adjacentPassword: true,
    });
    expect(fieldKindAllowed("username", read.get(1)!, false)).toBe(false);
    expect(fieldKindAllowed("username", read.get(3)!, false)).toBe(true);
    expect(fieldKindAllowed("code", read.get(6)!, false)).toBe(true);
    expect(read.get(7)?.hints).toEqual(["billing", "zip"]);
    expect(fieldKindAllowed("code", read.get(7)!, false)).toBe(false);
  });
});

describe("reading a total off the page", () => {
  it("reads one number and the currencies it may be in", () => {
    expect(readPageTotal("Total ₹1,234.00")).toEqual({
      amount: "1234.00",
      currencies: ["INR"],
    });
    expect(readPageTotal("1.234,50 €")).toEqual({
      amount: "1234.50",
      currencies: ["EUR"],
    });
    expect(readPageTotal("USD 99.5")?.currencies).toContain("USD");
    expect(readPageTotal("Rs. 500")?.currencies).toEqual(["INR"]);
    expect(readPageTotal("$12")?.currencies).toContain("CAD");
  });

  it("reads nothing from text with no number or several", () => {
    expect(readPageTotal("Total")).toBeNull();
    expect(readPageTotal("2 items, ₹1,234.00")).toBeNull();
  });

  it("compares amounts as numbers", () => {
    expect(sameAmount("1234", "1234.00")).toBe(true);
    expect(sameAmount("1234.01", "1234.00")).toBe(false);
  });
});

describe("an input's facts as the page has it now", () => {
  /** Stand-in inputs in one document, in order; each answers like a DOM input. */
  const page = (...attributeSets: Array<Record<string, string>>) => {
    const elements: Array<Record<string, unknown>> = [];
    const root = { querySelectorAll: () => elements };
    for (const attributes of attributeSets)
      elements.push({
        tagName: "INPUT",
        isConnected: true,
        disabled: false,
        readOnly: false,
        getAttribute: (name: string) => attributes[name] ?? null,
        hasAttribute: (name: string) => name in attributes,
        getRootNode: () => root,
        labels: attributes["data-label"]
          ? [{ textContent: attributes["data-label"] }]
          : [],
      });
    return elements;
  };
  const live = (element: unknown): { facts: FieldFacts } =>
    (
      new Function(`return (${LIVE_FIELD_FUNCTION});`)() as () => {
        facts: FieldFacts;
      }
    ).call(element);

  it("reads the same facts the first sighting does", () => {
    const [search, , email, password, code] = page(
      { type: "search" },
      { type: "hidden" },
      { type: "email", autocomplete: "Email" },
      { type: "password" },
      { inputmode: "numeric", maxlength: "6", pattern: "\\d*" }
    );

    expect(live(search).facts).toMatchObject({
      type: "search",
      adjacentPassword: false,
    });
    expect(live(email).facts).toMatchObject({
      type: "email",
      autocomplete: ["email"],
      adjacentPassword: true,
    });
    expect(live(password).facts.wasPassword).toBe(true);
    expect(fieldKindAllowed("code", live(code).facts, false)).toBe(true);
    expect(fieldKindAllowed("username", live(search).facts, false)).toBe(false);
    const [zip] = page({
      inputmode: "numeric",
      maxlength: "6",
      "data-label": "ZIP code",
    });
    expect(live(zip).facts.hints).toEqual(["zip", "code"]);
    expect(fieldKindAllowed("code", live(zip).facts, false)).toBe(false);
  });
});

describe("a login fill", () => {
  it("goes under the sign-in the user allowed, on its site and subdomains, and spends that field", () => {
    const allowed = signin();
    const plan = planFill(loginContext({ signin: allowed, field: "username" }));
    expect(plan).toMatchObject({
      ok: true,
      request: {
        origin: "https://www.example.com",
        signinApprovalId: "signin-1",
      },
    });
    expect(plan.ok && plan.uses).toBe(allowed.used);
  });

  it("waits for the user's approval when none is allowed, and says so apart from a page failure", () => {
    const plan = planFill(loginContext({ signin: null }));
    expect(plan).toMatchObject({ ok: false, awaitingApproval: true });
    if (plan.ok === false) {
      expect(plan.error).toMatch(/^Waiting for sign-in approval:/);
      expect(plan.error).toContain('need:"login"');
      // The approval's id is the host's alone: no refusal names it.
      expect(plan.error).not.toContain("signin-1");
    }
  });

  it("is refused for another login, another site, or a field already filled under it", () => {
    for (const plan of [
      planFill(loginContext({ itemId: "login-2" })),
      planFill(loginContext({ topOrigin: "https://example.com.evil.net" })),
      planFill(loginContext({ topOrigin: "https://notexample.com" })),
      planFill(
        loginContext({ signin: signin({ used: new Set(["password"]) }) })
      ),
    ])
      expect(plan).toMatchObject({ ok: false, awaitingApproval: true });
    // A username filled on the first step leaves the password for the next.
    expect(
      planFill(
        loginContext({ signin: signin({ used: new Set(["username"]) }) })
      ).ok
    ).toBe(true);
  });

  it("puts a login's sign-in code under the same sign-in, and a bank's code under the payment", () => {
    expect(planFill(loginContext({ field: "code", signin: null })).ok).toBe(
      false
    );
    expect(planFill(loginContext({ field: "code" }))).toMatchObject({
      ok: true,
      request: { signinApprovalId: "signin-1" },
    });
    // A card's code never goes under a sign-in, nor a card field.
    expect(
      planFill(context({ approval: null, signin: signin({ item: "card-1" }) }))
        .ok
    ).toBe(false);
  });
});
