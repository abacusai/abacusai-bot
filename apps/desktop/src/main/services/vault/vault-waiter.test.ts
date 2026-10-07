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
