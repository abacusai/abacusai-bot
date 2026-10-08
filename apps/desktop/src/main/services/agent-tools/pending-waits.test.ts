import { describe, expect, it } from "vitest";

import type { CheckoutPause } from "../vault/checkout-run";
import {
  PAYMENT_STEP_HOLD_MS,
  REQUEST_LIFETIME_MS,
  VaultSession,
} from "../vault/vault-session";
import { CONNECT_OFFER_LIFETIME_MS, PendingWaits } from "./pending-waits";

describe("PendingWaits: connector offers", () => {
  it("lists a session's unconnected offers by connector, never another session's", () => {
    let now = 1_000;
    const waits = new PendingWaits(() => now);
    waits.connectOffered("phone", [
      { id: "gmail", label: "Gmail", service: "gmailuser" },
    ]);
    now = 2_000;
    waits.connectOffered("other", [
      { id: "slack", label: "Slack", service: "slackuser" },
    ]);
    expect(waits.list("phone", new Set())).toEqual([
      {
        itemId: "connect:gmailuser",
        kind: "connector",
        stage: "link_sent",
        site: null,
        label: "Gmail",
        since: 1_000,
        expiresAt: 1_000 + CONNECT_OFFER_LIFETIME_MS,
      },
    ]);
  });

  it("drops what connected, through the watcher or seen in the statuses", () => {
    const waits = new PendingWaits(() => 0);
    waits.connectOffered("phone", [
      { id: "gmail", label: "Gmail", service: "gmailuser" },
      {
        id: "google-calendar",
        label: "Google Calendar",
        service: "googlecalendaruser",
      },
      { id: "slack", label: "Slack", service: "slackuser" },
    ]);
    waits.connectLanded(["gmail"]);
    expect(
      waits.list("phone", new Set(["slack"])).map((wait) => wait.itemId)
    ).toEqual(["connect:googlecalendaruser"]);
  });

  it("restarts an offer's clock when it is sent again, and lets it go once its life is over", () => {
    let now = 0;
    const waits = new PendingWaits(() => now);
    waits.connectOffered("phone", [
      { id: "gmail", label: "Gmail", service: "gmailuser" },
    ]);
    now = 10_000;
    waits.connectOffered("phone", [
      { id: "gmail", label: "Gmail", service: "gmailuser" },
    ]);
    expect(waits.list("phone", new Set())[0]!.since).toBe(10_000);
    now = 10_000 + CONNECT_OFFER_LIFETIME_MS;
    expect(waits.list("phone", new Set())).toEqual([]);
  });

  it("says whether a session has offers open", () => {
    const waits = new PendingWaits();
    expect(waits.hasOffers("phone")).toBe(false);
    waits.connectOffered("phone", [
      { id: "gmail", label: "Gmail", service: "gmailuser" },
    ]);
    expect(waits.hasOffers("phone")).toBe(true);
    waits.connectLanded(["gmail"]);
    expect(waits.hasOffers("phone")).toBe(false);
  });

  it("ignores an offer with no session", () => {
    const waits = new PendingWaits();
    waits.connectOffered(null, [
      { id: "gmail", label: "Gmail", service: "gmailuser" },
    ]);
    expect(waits.list("", new Set())).toEqual([]);
  });
});

const pause = (
  need: CheckoutPause["need"],
  extra: Partial<CheckoutPause> = {}
): CheckoutPause => ({
  need,
  fields: [],
  site: "akasaair.com",
  amount: null,
  currency: null,
  merchant: "Page Text Merchant",
  cvvRequired: false,
  summary: "the sub-agent's own words",
  mediaId: "m-1",
  ...extra,
});

describe("PendingWaits: the vault and the checkout", () => {
  const setup = () => {
    let now = 1_000_000;
    const clock = () => now;
    const waits = new PendingWaits(clock);
    const vault = new VaultSession(clock);
    return {
      waits,
      vault,
      list: () => waits.list("phone", new Set(), vault),
      tick: (ms: number) => (now += ms),
      now: () => now,
    };
  };

  it("lists a pending sign-in by its site, with no approval or item id, until it is answered or expires", () => {
    const { vault, list, tick, now } = setup();
    vault.signin = {
      id: "signin-secret",
      item: "login-item-secret",
      site: "linkedin.com",
      status: "pending",
      used: new Set(),
      expiresAt: now() + 60_000,
    };
    const listed = list();
    expect(listed).toEqual([
      expect.objectContaining({
        kind: "signin",
        stage: "approval",
        site: "linkedin.com",
        expiresAt: now() + 60_000,
      }),
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/secret/);
    vault.signin.status = "approved";
    expect(list()).toEqual([]);
    vault.signin.status = "pending";
    tick(60_000);
    expect(list()).toEqual([]);
  });

  it("lists pages sent and not completed, by kind and site, with no request or item id", () => {
    const { vault, list, now } = setup();
    vault.requests.set("req-secret-1", {
      requestId: "req-secret-1",
      kind: "login",
      site: "akasaair.com",
      itemId: "vault-item-9",
      forPayment: false,
      expiresAt: now() + REQUEST_LIFETIME_MS,
    });
    vault.requests.set("req-secret-2", {
      requestId: "req-secret-2",
      kind: "code",
      site: "vault-item-9",
      itemId: null,
      forPayment: false,
      expiresAt: now() + 60_000,
    });
    const listed = list();
    expect(
      listed.map(({ kind, stage, site }) => ({ kind, stage, site }))
    ).toEqual([
      { kind: "vault_login", stage: "page_sent", site: "akasaair.com" },
      { kind: "vault_code", stage: "page_sent", site: null },
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/req-secret|vault-item/);
  });

  it("keeps one wait's item id and start while it lasts, and forgets it once it is gone", () => {
    const { vault, list, tick, now } = setup();
    vault.requests.set("r1", {
      requestId: "r1",
      kind: "card",
      site: null,
      itemId: null,
      forPayment: false,
      expiresAt: now() + REQUEST_LIFETIME_MS,
    });
    const [first] = list();
    tick(60_000);
    expect(list()[0]).toEqual(first);
    vault.requests.delete("r1");
    expect(list()).toEqual([]);
    vault.requests.set("r1", {
      requestId: "r1",
      kind: "card",
      site: null,
      itemId: null,
      forPayment: false,
      expiresAt: now() + 60_000,
    });
    expect(list()[0]!.itemId).not.toBe(first!.itemId);
  });

  it("lists a pending payment approval with the payee, total and site the server bound, and not its paused checkout again", () => {
    const { vault, list, now } = setup();
    vault.checkout.pause(
      pause("payment", { amount: "5412.00", currency: "INR" })
    );
    vault.approval = {
      id: "approval-secret",
      item: "card-item-secret",
      merchant: "Akasa Air",
      amount: "5412.00",
      currency: "INR",
      site: "akasaair.com",
      cvvRequired: false,
      status: "pending",
      used: new Set(),
      codeOrigin: null,
      expiresAt: now() + 8 * 60_000,
    };
    const listed = list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      kind: "payment",
      stage: "approval",
      site: "akasaair.com",
      merchant: "Akasa Air",
      amount: "5412.00",
      currency: "INR",
      expiresAt: now() + 8 * 60_000,
    });
    expect(JSON.stringify(listed)).not.toMatch(/secret/);
    vault.approval.status = "approved";
    expect(list()).toEqual([
      expect.objectContaining({
        kind: "checkout",
        merchant: "Akasa Air",
        amount: "5412.00",
        currency: "INR",
      }),
    ]);
  });

  it("lists a checkout paused for the user by what it paused for, never the page's or the model's words", () => {
    const { vault, list, tick, now } = setup();
    vault.checkout.pause(pause("details"));
    const [wait] = list();
    expect(wait).toMatchObject({
      kind: "checkout",
      stage: "details",
      site: "akasaair.com",
      expiresAt: now() + REQUEST_LIFETIME_MS,
    });
    expect(JSON.stringify(wait)).not.toMatch(/Merchant|sub-agent|m-1/);
    tick(REQUEST_LIFETIME_MS);
    expect(list()).toEqual([]);
  });

  it("gives a paused payment the payment step's hold, and only the total the server bound", () => {
    const { vault, list, now } = setup();
    vault.checkout.pause(
      pause("payment", { amount: "99.50", currency: "USD" })
    );
    const [wait] = list();
    expect(wait).toMatchObject({
      stage: "payment",
      expiresAt: now() + PAYMENT_STEP_HOLD_MS,
    });
    expect(wait).not.toHaveProperty("amount");
  });
});
