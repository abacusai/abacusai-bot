import { describe, expect, it } from "vitest";

import {
  type Activation,
  activationVerdict,
  activatesControl,
  approvalCovers,
  commitVerdict,
  type ControlFacts,
  FRAME_REFUSAL,
  type GuardState,
  navigationVerdict,
  PAY_REFUSAL,
  SAVE_CARD_REFUSAL,
  SAVED_CARD_REFUSAL,
  siteOf,
  OTHER_REFUSAL,
  REVIEW_COMMIT_REFUSAL,
  STEP_REFUSAL,
  UNREADABLE_REFUSAL,
  UPI_REFUSAL,
  USED_REFUSAL,
} from "./pay-guard";

const facts = (over: Partial<ControlFacts> = {}): ControlFacts => ({
  found: true,
  kind: "other",
  label: "",
  attrs: "",
  checked: false,
  url: "https://www.akasaair.com/booking/review",
  cardFields: false,
  paymentFrame: false,
  submitsCardForm: false,
  savedCardSelected: false,
  maskedCardOnPage: false,
  priceOnPage: false,
  commitControlOnPage: false,
  role: "",
  expands: false,
  frameIsProvider: false,
  ...over,
});

const payPage = (over: Partial<ControlFacts> = {}) =>
  facts({ url: "https://www.akasaair.com/payment", cardFields: true, ...over });

const state = (
  over: Partial<Omit<GuardState, "approval">> = {},
  approval: Partial<GuardState["approval"]> = {}
): GuardState => ({
  knownPaymentStep: false,
  pastReview: false,
  bankStep: false,
  ...over,
  approval: {
    live: false,
    coversSite: true,
    paid: false,
    reviewed: false,
    bankSubmitted: false,
    ...approval,
  },
});

const CLICK: Activation = { action: "click", selector: "#x" };
const key = (k: string): Activation => ({ action: "key", key: k });

describe("an activation, off a payment step", () => {
  it("goes through when its words do not commit", () => {
    for (const label of [
      "Continue to book with Akasa Air",
      "Continue to payment",
      "Select",
      "Pay with card",
      "Search flights",
    ])
      expect(
        activationVerdict(CLICK, facts({ label }), state()),
        label
      ).toEqual({
        kind: "allow",
      });
  });

  it("is refused without an approval when its words or attributes commit, in a few languages", () => {
    for (const over of [
      { label: "Pay ₹1,234.00" },
      { label: "Place order" },
      { label: "Confirm booking" },
      { label: "Book now" },
      { label: "Pagar ahora" },
      { label: "Jetzt bezahlen" },
      { label: "立即支付" },
      { label: "→", attrs: "btn-pay" },
    ])
      expect(
        activationVerdict(CLICK, facts(over), state()),
        JSON.stringify(over)
      ).toEqual({ kind: "refuse", reason: PAY_REFUSAL });
  });
});

describe("an activation on a payment step, or past the review", () => {
  it("is refused without an approval whatever its words, unless it is a field or method", () => {
    for (const label of ["Continue", "→", "Weiter", ""])
      expect(
        activationVerdict(CLICK, payPage({ kind: "submit", label }), state())
      ).toEqual({ kind: "refuse", reason: STEP_REFUSAL });
    for (const kind of [
      "text-field",
      "select",
      "radio",
      "checkbox",
      "card-method",
    ] as const)
      expect(
        activationVerdict(CLICK, payPage({ kind, label: "Card" }), state()),
        kind
      ).toEqual({ kind: "allow" });
  });

  it("is a payment step by its marks, by memory, or by the checkout's stage", () => {
    const button = facts({ kind: "submit", label: "Continue" });
    expect(activationVerdict(CLICK, button, state()).kind).toBe("allow");
    for (const over of [
      { paymentFrame: true },
      { submitsCardForm: true },
      { url: "https://js.stripe.com/v3/elements" },
      { url: "https://shop.example/checkout/step-3" },
      { savedCardSelected: true },
      { maskedCardOnPage: true },
      { url: "https://shop.example/order/review", priceOnPage: true },
    ])
      expect(
        activationVerdict(CLICK, { ...button, ...over }, state()).kind,
        JSON.stringify(over)
      ).toBe("refuse");
    expect(
      activationVerdict(CLICK, button, state({ knownPaymentStep: true })).kind
    ).toBe("refuse");
    expect(
      activationVerdict(CLICK, button, state({ pastReview: true })).kind
    ).toBe("refuse");
  });

  it("with a live approval, is the payment itself on a card step, once", () => {
    const pay = payPage({ kind: "submit", label: "Pay" });
    expect(activationVerdict(CLICK, pay, state({}, { live: true }))).toEqual({
      kind: "commit",
      tier: "pay",
    });
    expect(
      activationVerdict(CLICK, pay, state({}, { live: true, paid: true }))
    ).toEqual({ kind: "refuse", reason: USED_REFUSAL });
    expect(
      activationVerdict(
        CLICK,
        pay,
        state({}, { live: true, coversSite: false })
      ).kind
    ).toBe("refuse");
  });

  it("before the card, lets one step from the review through under the approval, and no second", () => {
    const review = facts({
      url: "https://www.akasaair.com/booking/review",
      priceOnPage: true,
      kind: "submit",
      label: "Continue",
    });
    expect(activationVerdict(CLICK, review, state())).toEqual({
      kind: "refuse",
      reason: STEP_REFUSAL,
    });
    expect(activationVerdict(CLICK, review, state({}, { live: true }))).toEqual(
      {
        kind: "commit",
        tier: "review",
      }
    );
    expect(
      activationVerdict(
        CLICK,
        review,
        state({}, { live: true, reviewed: true })
      )
    ).toEqual({ kind: "refuse", reason: USED_REFUSAL });
  });

  it("before the card, refuses a control that commits by its words, approved or not", () => {
    for (const label of ["Place order", "Confirm booking", "Book now"]) {
      const review = facts({
        url: "https://www.akasaair.com/booking/review",
        priceOnPage: true,
        kind: "submit",
        label,
      });
      for (const live of [false, true])
        expect(
          activationVerdict(CLICK, review, state({}, { live })).kind,
          `${label} ${live}`
        ).toBe("refuse");
      expect(
        activationVerdict(CLICK, review, state({}, { live: true }))
      ).toEqual({ kind: "refuse", reason: REVIEW_COMMIT_REFUSAL });
    }
  });

  it("refuses a saved card on the page whether or not the payment is approved", () => {
    const pay = payPage({
      kind: "submit",
      label: "Pay",
      savedCardSelected: true,
    });
    for (const live of [false, true])
      expect(activationVerdict(CLICK, pay, state({}, { live }))).toEqual({
        kind: "refuse",
        reason: SAVED_CARD_REFUSAL,
      });
  });

  it("does not spend the approval on a control that commits nothing: menus and details go, the rest is refused", () => {
    const approved = state({}, { live: true });
    for (const over of [
      { role: "combobox" },
      { role: "option" },
      { role: "menuitem" },
      { expands: true, label: "Fare details" },
      { label: "View details" },
    ])
      expect(
        activationVerdict(CLICK, payPage({ kind: "other", ...over }), approved),
        JSON.stringify(over)
      ).toEqual({ kind: "allow" });
    for (const over of [
      { label: "Apply coupon" },
      { kind: "link" as const, label: "Terms" },
    ])
      expect(
        activationVerdict(CLICK, payPage({ kind: "other", ...over }), approved),
        JSON.stringify(over)
      ).toEqual({ kind: "refuse", reason: OTHER_REFUSAL });
  });

  it("lets the bank's code step submit once after the payment", () => {
    const submit = facts({ kind: "submit", label: "Submit" });
    const bank = state(
      { bankStep: true, pastReview: true },
      { live: true, paid: true }
    );
    expect(activationVerdict(CLICK, submit, bank)).toEqual({ kind: "bank" });
    expect(
      activationVerdict(CLICK, submit, {
        ...bank,
        approval: { ...bank.approval, bankSubmitted: true },
      })
    ).toEqual({ kind: "refuse", reason: USED_REFUSAL });
  });

  it("refuses a key into another site's frame, and treats a provider's as the payment", () => {
    expect(
      activationVerdict(
        key("Enter"),
        payPage({ kind: "frame", frameIsProvider: false }),
        state({}, { live: true })
      )
    ).toEqual({ kind: "refuse", reason: FRAME_REFUSAL });
    expect(
      activationVerdict(
        key("Enter"),
        payPage({ kind: "frame", frameIsProvider: true }),
        state({}, { live: true })
      )
    ).toEqual({ kind: "commit", tier: "pay" });
  });
});

describe("what is refused even with an approval", () => {
  const approved = state({}, { live: true });

  it("UPI and wallets, on any control", () => {
    for (const over of [
      { kind: "radio" as const, label: "UPI" },
      { kind: "submit" as const, label: "Pay using UPI" },
      { kind: "radio" as const, label: "Google Pay" },
      { kind: "radio" as const, attrs: "pm-upi" },
    ])
      expect(activationVerdict(CLICK, payPage(over), approved)).toEqual({
        kind: "refuse",
        reason: UPI_REFUSAL,
      });
  });

  it("a card the site saved, picked by click or check", () => {
    for (const [activation, label] of [
      [CLICK, "Use saved card"],
      [CLICK, "Visa •••• 4242"],
      [
        { action: "check", selector: "#c" } as Activation,
        "HDFC card ending 1234",
      ],
    ] as const)
      expect(
        activationVerdict(
          activation,
          payPage({ kind: "radio", label }),
          approved
        )
      ).toEqual({ kind: "refuse", reason: SAVED_CARD_REFUSAL });
  });

  it("ticking save-this-card, by click, check or Space; unticking is fine", () => {
    const box = payPage({
      kind: "checkbox",
      label: "Save this card for later",
    });
    for (const activation of [
      CLICK,
      { action: "check", selector: "#c" } as Activation,
      key("Space"),
    ])
      expect(activationVerdict(activation, box, approved)).toEqual({
        kind: "refuse",
        reason: SAVE_CARD_REFUSAL,
      });
    expect(
      activationVerdict(CLICK, { ...box, checked: true }, approved).kind
    ).toBe("allow");
    expect(
      activationVerdict({ action: "uncheck", selector: "#c" }, box, approved)
        .kind
    ).toBe("allow");
  });
});

describe("keys", () => {
  it("guards every key that can activate or submit", () => {
    for (const k of [
      "Enter",
      "NumpadEnter",
      "\r",
      "\n",
      "Shift+Enter",
      " ",
      "Space",
    ])
      expect(activatesControl(k), JSON.stringify(k)).toBe(true);
    for (const k of ["Tab", "ArrowDown", "a", "Escape", "Control+a"])
      expect(activatesControl(k), k).toBe(false);
  });

  it("lets Space toggle a checkbox or radio on a payment step, not press a button", () => {
    expect(
      activationVerdict(key("Space"), payPage({ kind: "radio" }), state()).kind
    ).toBe("allow");
    expect(
      activationVerdict(key("Space"), payPage({ kind: "submit" }), state()).kind
    ).toBe("refuse");
    expect(
      activationVerdict(key("Enter"), payPage({ kind: "text-field" }), state())
        .kind
    ).toBe("refuse");
  });
});

describe("unreadable controls", () => {
  it("are refused, and a missing one is left to the action", () => {
    expect(activationVerdict(CLICK, null, state())).toEqual({
      kind: "refuse",
      reason: UNREADABLE_REFUSAL,
    });
    expect(
      activationVerdict(CLICK, facts({ found: false }), state()).kind
    ).toBe("allow");
  });
});

describe("the payment's total", () => {
  const approval = { amount: "1234.00", currency: "INR" };

  it("goes through only when the page shows the approved amount and currency", () => {
    expect(
      commitVerdict({ amount: "1234", currencies: ["INR"] }, approval)
    ).toBeNull();
    expect(commitVerdict(null, approval)).toMatch(/total_ref/);
    expect(
      commitVerdict({ amount: "1250.00", currencies: ["INR"] }, approval)
    ).toMatch(/page shows 1250.00/);
    expect(
      commitVerdict({ amount: "1234.00", currencies: ["USD"] }, approval)
    ).toMatch(/Refused/);
  });
});

describe("navigation", () => {
  const from = "https://www.akasaair.com/payment";

  it("from a payment step: same-site loads, reloads and forward are refused; cross-site and back are not", () => {
    const base = { from, strict: true, approvalLive: false } as const;
    expect(
      navigationVerdict({
        ...base,
        action: "goto",
        to: "https://akasaair.com/pay/confirm",
      })
    ).toMatch(/Refused/);
    expect(
      navigationVerdict({
        ...base,
        action: "goto",
        to: "https://www.google.com/",
      })
    ).toBeNull();
    expect(navigationVerdict({ ...base, action: "reload", to: null })).toMatch(
      /Refused/
    );
    expect(navigationVerdict({ ...base, action: "forward", to: null })).toMatch(
      /Refused/
    );
    expect(navigationVerdict({ ...base, action: "back", to: null })).toBeNull();
    expect(
      navigationVerdict({
        ...base,
        action: "goto",
        to: "https://pay.other.example/pay/confirm?order=1",
      })
    ).toMatch(/place the order/);
  });

  it("off one: a URL that would place the order is refused without an approval", () => {
    const base = {
      action: "goto" as const,
      from: "https://shop.example/cart",
      strict: false,
    };
    expect(
      navigationVerdict({
        ...base,
        to: "https://shop.example/place-order",
        approvalLive: false,
      })
    ).toMatch(/place the order/);
    expect(
      navigationVerdict({
        ...base,
        to: "https://shop.example/products/1",
        approvalLive: false,
      })
    ).toBeNull();
  });

  it("from a page that cannot be read: same-site loads are refused", () => {
    expect(
      navigationVerdict({
        action: "goto",
        from,
        to: "https://www.akasaair.com/x",
        strict: null,
        approvalLive: false,
      })
    ).toMatch(/Refused/);
    expect(
      navigationVerdict({
        action: "goto",
        from: "about:blank",
        to: "https://www.akasaair.com/x",
        strict: null,
        approvalLive: false,
      })
    ).toBeNull();
  });

  it("knows a site by its registrable part", () => {
    expect(siteOf("www.akasaair.com")).toBe("akasaair.com");
    expect(siteOf("secure.shop.co.uk")).toBe("shop.co.uk");
    expect(siteOf("book.goindigo.in")).toBe("goindigo.in");
  });
});

describe("an approval's site", () => {
  it("covers the site and its subdomains, nothing else", () => {
    expect(approvalCovers("akasaair.com", "https://www.akasaair.com")).toBe(
      true
    );
    expect(approvalCovers("akasaair.com", "https://akasaair.com.evil.io")).toBe(
      false
    );
    expect(approvalCovers("akasaair.com", null)).toBe(false);
  });
});
