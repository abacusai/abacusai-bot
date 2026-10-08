import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {} }));

const { Vault } = await import("./vault-tools");
type VaultClient = import("./vault-client").VaultClient;

const ORIGIN = "https://checkout.example";

/** A platform whose request and approval statuses the test sets. */
const fakeClient = () => {
  const state = {
    request: "pending" as "pending" | "completed" | "failed" | "expired",
    approval: "pending" as "pending" | "approved" | "expired",
    statusCalls: 0,
    approvalCalls: 0,
    requests: [] as unknown[],
  };
  const client = {
    maybeAvailable: () => true,
    listItems: vi.fn(),
    createRequest: vi.fn(async (input: unknown) => {
      state.requests.push(input);
      return {
        ok: true as const,
        value: {
          requestId: "req-1",
          url: "https://example.test/app/vault/login?r=req-1",
          expiresAt: Math.floor(Date.now() / 1000) + 30 * 60,
        },
      };
    }),
    requestStatus: vi.fn(async () => {
      state.statusCalls += 1;
      return {
        ok: true as const,
        value: {
          status: state.request,
          itemId: state.request === "completed" ? "login-7" : null,
        },
      };
    }),
    createPaymentApproval: vi.fn(async (input: { amount: string }) => ({
      ok: true as const,
      value: {
        paymentApprovalId: "pay-1",
        url: "https://example.test/app/vault/payment?r=x",
        amount: input.amount,
        currency: "INR",
        site: "checkout.example",
        expiresAt: Math.floor(Date.now() / 1000) + 30 * 60,
      },
    })),
    paymentApprovalStatus: vi.fn(async () => {
      state.approvalCalls += 1;
      return { ok: true as const, value: { status: state.approval } };
    }),
    fill: vi.fn(),
  };
  return { client: client as unknown as VaultClient, raw: client, state };
};

const browser = {
  topOrigin: async () => ORIGIN,
  codePages: async () => [] as Array<{ origin: string; top: boolean }>,
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const setup = () => {
  const { client, state } = fakeClient();
  const delivered: Array<[string, string]> = [];
  const vault = new Vault({
    client,
    deliver: (sessionId, note) => {
      delivered.push([sessionId, note]);
    },
  });
  return { vault, state, delivered };
};

/** `setup`, with the fake client's mocks at hand. */
const setupWithClient = () => {
  const { client, raw } = fakeClient();
  const vault = new Vault({ client, deliver: () => {} });
  return { vault, client: raw };
};

describe("VaultWaiter", () => {
  it("polls every 3 s while a page is out, and raises its note once", async () => {
    const { vault, state, delivered } = setup();
    await vault.run(
      "vault_request",
      { kind: "login", site: "linkedin.com" },
      "s1",
      browser
    );

    await vi.advanceTimersByTimeAsync(3_000);
    expect(state.statusCalls).toBe(1);
    expect(delivered).toHaveLength(0);

    state.request = "completed";
    await vi.advanceTimersByTimeAsync(3_000);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]![0]).toBe("s1");
    expect(delivered[0]![1]).toContain("login-7");
    // A structured handle for the browser run, not an id buried in task text.
    expect(delivered[0]![1]).toContain("login_item_id login-7 to browser_task");
    expect(delivered[0]![1]).toContain("continue_from_last");
    expect(delivered[0]![1]).toContain("linkedin.com");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(delivered).toHaveLength(1);
    expect(state.statusCalls).toBe(2);
  });

  it("raises a note when saving failed", async () => {
    const { vault, state, delivered } = setup();
    await vault.run("vault_request", { kind: "card" }, "s1", browser);
    state.request = "failed";

    await vi.advanceTimersByTimeAsync(3_000);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]![1]).toMatch(/failed/);
  });

  it("stops on expiry, without a note", async () => {
    const { vault, state, delivered } = setup();
    await vault.run(
      "vault_request",
      { kind: "login", site: "x.com" },
      "s1",
      browser
    );

    await vi.advanceTimersByTimeAsync(31 * 60_000);
    const calls = state.statusCalls;
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(state.statusCalls).toBe(calls);
    expect(delivered).toHaveLength(0);
    expect(vault.sessions.get("s1")).toBeNull();
  });

  it("stops when the server says the page expired", async () => {
    const { vault, state, delivered } = setup();
    await vault.run(
      "vault_request",
      { kind: "login", site: "x.com" },
      "s1",
      browser
    );
    state.request = "expired";

    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(state.statusCalls).toBe(1);
    expect(delivered).toHaveLength(0);
  });

  it('checks at once when the user says "done", and hands what it finds to that message', async () => {
    const { vault, state, delivered } = setup();
    await vault.run(
      "vault_request",
      { kind: "login", site: "linkedin.com" },
      "s1",
      browser
    );
    state.request = "completed";

    const notes = await vault.checkBeforeMessage("s1");

    expect(state.statusCalls).toBe(1);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("login-7");
    // Reported once, with the message and not as a turn: the timer finds nothing left.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(delivered).toHaveLength(0);
    expect(state.statusCalls).toBe(1);
  });

  it("checks nothing for a message when nothing is outstanding", async () => {
    const { vault, state } = setup();

    expect(await vault.checkBeforeMessage("s1")).toEqual([]);

    expect(state.statusCalls).toBe(0);
  });

  it("follows a payment approval until it is approved, and then it can be filled", async () => {
    const { vault, state, delivered } = setup();
    await vault.run(
      "payment_approval",
      {
        item_id: "card-1",
        merchant: "Shop",
        amount: "1234.00",
        currency: "INR",
      },
      "s1",
      browser
    );
    expect(vault.approval("s1")).toBeNull();

    state.approval = "approved";
    await vi.advanceTimersByTimeAsync(3_000);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]![1]).toContain("1234.00 INR");
    expect(vault.approval("s1")).toMatchObject({
      id: "pay-1",
      item: "card-1",
      amount: "1234.00",
      status: "approved",
    });

    // Good for ten minutes from the approval.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(vault.approval("s1")).toBeNull();
  });
});

describe("asking for a bank's code", () => {
  const approved = (vault: InstanceType<typeof Vault>) => {
    vault.sessions.for("s1").approval = {
      id: "pay-1",
      item: "card-1",
      merchant: "Shop",
      amount: "1234.00",
      currency: "INR",
      site: "checkout.example",
      cvvRequired: false,
      status: "approved",
      used: new Set(),
      codeOrigin: null,
      expiresAt: Date.now() + 60_000,
    };
  };
  const on = (...pages: Array<{ origin: string; top: boolean }>) => ({
    topOrigin: async () => ORIGIN,
    codePages: async () => pages,
  });

  it("binds it to the bank's page when that replaced the checkout", async () => {
    const { vault, state } = setup();
    approved(vault);

    const result = await vault.run(
      "vault_request",
      { kind: "code" },
      "s1",
      on({ origin: "https://secure.bank.example", top: true })
    );

    expect(result.isError).not.toBe(true);
    expect(state.requests[0]).toEqual({
      kind: "code",
      paymentApprovalId: "pay-1",
      origin: "https://secure.bank.example",
    });
    expect(vault.approval("s1")?.codeOrigin).toBe(
      "https://secure.bank.example"
    );
  });

  it("binds it to the bank's code frame on the checkout, beside a payment provider's", async () => {
    const { vault, state } = setup();
    approved(vault);

    await vault.run(
      "vault_request",
      { kind: "code" },
      "s1",
      on(
        { origin: "https://www.checkout.example", top: true },
        { origin: "https://js.stripe.com", top: false },
        { origin: "https://acs.bank.example", top: false }
      )
    );

    expect(state.requests[0]).toMatchObject({
      origin: "https://acs.bank.example",
    });
    expect(vault.approval("s1")?.codeOrigin).toBe("https://acs.bank.example");
  });

  it("refuses when no outside page or frame has a code field, or several do", async () => {
    const { vault, state } = setup();
    approved(vault);

    const none = await vault.run(
      "vault_request",
      { kind: "code" },
      "s1",
      on({ origin: "https://www.checkout.example", top: true })
    );
    const several = await vault.run(
      "vault_request",
      { kind: "code" },
      "s1",
      on(
        { origin: "https://acs.bank.example", top: false },
        { origin: "https://other.bank.example", top: false }
      )
    );

    expect(none.isError).toBe(true);
    expect(several.isError).toBe(true);
    expect(state.requests).toHaveLength(0);
    expect(vault.approval("s1")?.codeOrigin).toBeNull();
  });

  it("binds nothing, and refuses, when the approval changed while the page was made", async () => {
    const { vault, client } = setupWithClient();
    approved(vault);
    const first = vault.approval("s1")!;
    const created = client.createRequest.getMockImplementation()!;
    client.createRequest.mockImplementationOnce(async (input: unknown) => {
      // A new approval replaced the one the code was asked for.
      approved(vault);
      return created(input);
    });

    const result = await vault.run(
      "vault_request",
      { kind: "code" },
      "s1",
      on({ origin: "https://acs.bank.example", top: false })
    );

    expect(result.isError).toBe(true);
    expect(first.codeOrigin).toBeNull();
    expect(vault.approval("s1")?.codeOrigin).toBeNull();
  });

  it("binds nothing when the server would not create the request", async () => {
    const { vault, client } = setupWithClient();
    approved(vault);
    client.createRequest.mockResolvedValueOnce({
      ok: false,
      unavailable: false,
      error: "Too many vault links in the last hour.",
    } as never);

    const result = await vault.run(
      "vault_request",
      { kind: "code" },
      "s1",
      on({ origin: "https://acs.bank.example", top: false })
    );

    expect(result.isError).toBe(true);
    expect(vault.approval("s1")?.codeOrigin).toBeNull();
  });
});

describe("sign-in approvals in the waiter", () => {
  /** A platform that answers sign-in calls with what the test sets. */
  const signinClient = () => {
    const state = {
      signin: "pending" as "pending" | "approved" | "denied" | "expired",
      request: {
        status: "pending",
        itemId: null as string | null,
        signinApprovalId: null as string | null,
      },
      signinCalls: 0,
    };
    const client = {
      maybeAvailable: () => true,
      createRequest: vi.fn(async () => ({
        ok: true as const,
        value: {
          requestId: "req-login",
          url: "https://example.test/app/vault/login?r=x",
          expiresAt: null,
        },
      })),
      requestStatus: vi.fn(async () => ({
        ok: true as const,
        value: state.request,
      })),
      createSigninApproval: vi.fn(async () => ({
        ok: true as const,
        value: {
          signinApprovalId: "sa-hidden",
          url: "https://example.test/app/vault/signin?r=x",
          site: "shop.example",
          expiresAt: Math.floor(Date.now() / 1000) + 30 * 60,
        },
      })),
      signinApprovalStatus: vi.fn(async () => {
        state.signinCalls += 1;
        return {
          ok: true as const,
          value: {
            status: state.signin,
            site: "shop.example",
            expiresAt: Math.floor(Date.now() / 1000) + 5 * 60,
          },
        };
      }),
      paymentApprovalStatus: vi.fn(),
    };
    const vault = new Vault({
      client: client as unknown as VaultClient,
      deliver: () => {},
    });
    return { vault, state, client };
  };

  it("drops a pending sign-in that outlived its page without asking the platform", async () => {
    const { vault, state } = signinClient();
    await vault.run("signin_approval", { item_id: "login-1" }, "s1", browser);
    expect(vault.sessions.get("s1")?.signin?.status).toBe("pending");

    // The polling is off: this is the check itself on a page that has gone.
    vault.waiter.stop();
    vi.advanceTimersByTime(31 * 60_000);
    expect(await vault.waiter.checkNow("s1")).toEqual([]);
    expect(state.signinCalls).toBe(0);
    expect(vault.sessions.get("s1")?.signin ?? null).toBeNull();
  });

  it("drops one the platform says expired, with no note", async () => {
    const { vault, state } = signinClient();
    await vault.run("signin_approval", { item_id: "login-1" }, "s1", browser);
    state.signin = "expired";

    expect(await vault.waiter.checkNow("s1")).toEqual([]);
    expect(vault.sessions.get("s1")?.signin ?? null).toBeNull();
  });

  it("lets an allowed sign-in lapse when its five minutes are up", async () => {
    const { vault, state } = signinClient();
    await vault.run("signin_approval", { item_id: "login-1" }, "s1", browser);
    state.signin = "approved";
    await vault.waiter.checkNow("s1");
    expect(vault.signin("s1")?.item).toBe("login-1");

    vi.advanceTimersByTime(5 * 60_000 - 1_000);
    expect(vault.signin("s1")).not.toBeNull();
    vi.advanceTimersByTime(2_000);
    expect(vault.signin("s1")).toBeNull();
  });

  it("keeps one session's sign-in from another session", async () => {
    const { vault, state } = signinClient();
    await vault.run("signin_approval", { item_id: "login-1" }, "s1", browser);
    state.signin = "approved";
    await vault.waiter.checkNow("s1");

    expect(vault.signin("s1")).not.toBeNull();
    expect(vault.signin("s2")).toBeNull();
    expect(await vault.waiter.checkNow("s2")).toEqual([]);
  });

  it("says a save allowed the first sign-in only when that grant was held", async () => {
    const held = signinClient();
    await held.vault.run(
      "vault_request",
      { kind: "login", site: "shop.example" },
      "s1",
      browser
    );
    held.state.request = {
      status: "completed",
      itemId: "login-1",
      signinApprovalId: "sa-saved",
    };
    held.state.signin = "approved";
    const [heldNote] = await held.vault.waiter.checkNow("s1");
    expect(heldNote).toContain("Saving it allowed this first sign-in");
    expect(held.vault.signin("s1")?.item).toBe("login-1");

    const lost = signinClient();
    await lost.vault.run(
      "vault_request",
      { kind: "login", site: "shop.example" },
      "s1",
      browser
    );
    lost.state.request = {
      status: "completed",
      itemId: "login-1",
      signinApprovalId: "sa-saved",
    };
    lost.state.signin = "expired";
    const [lostNote] = await lost.vault.waiter.checkNow("s1");
    expect(lostNote).not.toContain("Saving it allowed");
    expect(lostNote).toContain("needs signin_approval");
    expect(lost.vault.signin("s1")).toBeNull();
  });
});
