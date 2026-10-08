import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {} }));

const { VaultClient, VAULT_UNAVAILABLE } = await import("./vault-client");

const SECRET = "hunter2-correct-horse";

interface Sent {
  url: URL;
  method: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

/** A platform that answers each method with `answers[method]`, recording what it was sent. */
const platform = (
  answers: Record<string, { status?: number; body: unknown }>
): { fetch: typeof fetch; sent: Sent[] } => {
  const sent: Sent[] = [];
  const fake = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    sent.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body != null ? JSON.parse(String(init.body)) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const method = url.pathname.split("/").at(-1)!;
    const answer = answers[method] ?? { status: 404, body: null };
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
    });
  }) as unknown as typeof fetch;
  return { fetch: fake, sent };
};

const client = (
  answers: Record<string, { status?: number; body: unknown }>,
  log = vi.fn()
) => {
  const { fetch, sent } = platform(answers);
  return {
    vault: new VaultClient({
      fetch,
      apiKey: () => "bot-key",
      host: () => "https://example.test",
      userAgent: () => "test-agent",
      log,
    }),
    sent,
    log,
  };
};

describe("VaultClient", () => {
  it("sends the platform's camelCase names, with the bot's key", async () => {
    const { vault, sent } = client({
      _fillAbacusbotVaultField: {
        body: { success: true, result: { value: SECRET } },
      },
    });

    const filled = await vault.fill({
      itemId: "item-1",
      field: "card_number",
      origin: "https://shop.example",
      paymentApprovalId: "pay-1",
      amount: "12.50",
      currency: "INR",
      frameOrigin: "https://js.stripe.com",
    });

    expect(filled).toEqual({ ok: true, value: SECRET });
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.url.pathname).toBe("/api/v1/_fillAbacusbotVaultField");
    expect(sent[0]!.headers.apikey).toBe("bot-key");
    expect(sent[0]!.body).toEqual({
      itemId: "item-1",
      field: "card_number",
      origin: "https://shop.example",
      paymentApprovalId: "pay-1",
      amount: "12.50",
      currency: "INR",
      frameOrigin: "https://js.stripe.com",
    });
  });

  it("never logs a request or response body, even when a call fails", async () => {
    const { vault, log } = client({
      _fillAbacusbotVaultField: {
        status: 500,
        body: { success: false, error: `boom ${SECRET}`.repeat(40) },
      },
    });
    const console_ = vi.spyOn(console, "warn").mockImplementation(() => {});

    const filled = await vault.fill({
      itemId: "item-1",
      field: "password",
      origin: "https://site.example",
    });

    expect(filled.ok).toBe(false);
    const logged = JSON.stringify([log.mock.calls, console_.mock.calls]);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain("site.example");
    expect(logged).toContain("_fillAbacusbotVaultField");
    console_.mockRestore();
  });

  it("passes the server's short reason back, for the model to act on", async () => {
    const { vault } = client({
      _fillAbacusbotVaultField: {
        status: 403,
        body: {
          success: false,
          error: "The checkout amount does not match the approved payment.",
        },
      },
    });

    expect(
      await vault.fill({
        itemId: "item-1",
        field: "card_number",
        origin: "https://shop.example",
      })
    ).toEqual({
      ok: false,
      unavailable: false,
      error: "The checkout amount does not match the approved payment.",
    });
  });

  it("calls the vault unavailable when the platform refuses it for the account, and stops listing it", async () => {
    const { vault } = client({
      _listAbacusbotVaultItems: {
        status: 403,
        body: {
          success: false,
          error: "The vault is not available for this account.",
        },
      },
    });

    expect(vault.maybeAvailable()).toBe(true);
    expect(await vault.listItems()).toEqual({
      ok: false,
      unavailable: true,
      error: VAULT_UNAVAILABLE,
    });
    expect(vault.maybeAvailable()).toBe(false);
  });

  it("is unavailable signed out, without calling anything", async () => {
    const { fetch, sent } = platform({});
    const vault = new VaultClient({ fetch, apiKey: () => "" });

    expect(vault.maybeAvailable()).toBe(false);
    expect((await vault.listItems()).ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("lists items as metadata only, whatever else a row carries", async () => {
    const { vault, sent } = client({
      _listAbacusbotVaultItems: {
        body: {
          success: true,
          result: [
            {
              itemId: "card-1",
              kind: "card",
              label: "Visa ••4242",
              sites: [],
              brand: "visa",
              last4: "4242",
              expiryMonth: 4,
              expiryYear: 2030,
              nameOnCard: "Ada L",
              value: SECRET,
            },
          ],
        },
      },
    });

    const listed = await vault.listItems();

    expect(sent[0]!.method).toBe("GET");
    expect(listed).toEqual({
      ok: true,
      value: [
        {
          itemId: "card-1",
          kind: "card",
          label: "Visa ••4242",
          sites: [],
          brand: "visa",
          last4: "4242",
          expiryMonth: 4,
          expiryYear: 2030,
          nameOnCard: "Ada L",
        },
      ],
    });
    expect(JSON.stringify(listed)).not.toContain(SECRET);
  });

  it("refuses an approval the platform returned without a site", async () => {
    const { vault } = client({
      _createAbacusbotPaymentApproval: {
        body: {
          success: true,
          result: {
            paymentApprovalId: "pay-1",
            url: "https://example.test/app/vault/payment?r=x",
            amount: "1.00",
            currency: "INR",
          },
        },
      },
    });
    const console_ = vi.spyOn(console, "warn").mockImplementation(() => {});

    const created = await vault.createPaymentApproval({
      itemId: "card-1",
      merchant: "Shop",
      amount: "1.00",
      currency: "INR",
      origin: "https://shop.example",
      cvvRequired: false,
    });

    expect(created.ok).toBe(false);
    console_.mockRestore();
  });

  it("reads a request's status by its id", async () => {
    const { vault, sent } = client({
      _getAbacusbotVaultRequestStatus: {
        body: { success: true, result: { status: "completed", itemId: "i-9" } },
      },
    });

    expect(await vault.requestStatus("req-1")).toEqual({
      ok: true,
      value: { status: "completed", itemId: "i-9", signinApprovalId: null },
    });
    expect(sent[0]!.url.searchParams.get("requestId")).toBe("req-1");
  });

  it("reads the sign-in a saved login's page allowed with its status", async () => {
    const { vault } = client({
      _getAbacusbotVaultRequestStatus: {
        body: {
          success: true,
          result: {
            status: "completed",
            itemId: "i-9",
            signinApprovalId: "sa-1",
          },
        },
      },
    });

    expect(await vault.requestStatus("req-1")).toEqual({
      ok: true,
      value: { status: "completed", itemId: "i-9", signinApprovalId: "sa-1" },
    });
  });

  it("asks for a sign-in approval for a saved login, and needs its link and site", async () => {
    const { vault, sent } = client({
      _createAbacusbotSigninApproval: {
        body: {
          success: true,
          result: {
            signinApprovalId: "sa-1",
            url: "https://example.test/app/vault/signin?r=abc",
            site: "shop.example",
            expiresAt: 1_900_000_000,
          },
        },
      },
    });

    expect(await vault.createSigninApproval({ itemId: "login-1" })).toEqual({
      ok: true,
      value: {
        signinApprovalId: "sa-1",
        url: "https://example.test/app/vault/signin?r=abc",
        site: "shop.example",
        expiresAt: 1_900_000_000,
      },
    });
    expect(sent[0]!.body).toEqual({
      itemId: "login-1",
    });

    const console_ = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { vault: siteless } = client({
      _createAbacusbotSigninApproval: {
        body: {
          success: true,
          result: { signinApprovalId: "sa-1", url: "https://x.test/v" },
        },
      },
    });
    expect(
      (await siteless.createSigninApproval({ itemId: "login-1" })).ok
    ).toBe(false);
    console_.mockRestore();
  });

  it("reads a sign-in approval's status, and anything else as expired", async () => {
    for (const [status, expected] of [
      ["approved", "approved"],
      ["pending", "pending"],
      ["denied", "denied"],
      ["expired", "expired"],
      ["weird", "expired"],
    ] as const) {
      const { vault } = client({
        _getAbacusbotSigninApproval: {
          body: {
            success: true,
            result: { status, site: "shop.example", expiresAt: 1_900_000_000 },
          },
        },
      });
      expect(await vault.signinApprovalStatus("sa-1")).toEqual({
        ok: true,
        value: {
          status: expected,
          site: "shop.example",
          expiresAt: 1_900_000_000,
        },
      });
    }
  });

  it("sends a login fill's sign-in approval with it", async () => {
    const { vault, sent } = client({
      _fillAbacusbotVaultField: {
        body: { success: true, result: { value: "pw" } },
      },
    });

    await vault.fill({
      itemId: "login-1",
      field: "password",
      origin: "https://www.shop.example",
      signinApprovalId: "sa-1",
    });
    expect(sent[0]!.body).toMatchObject({
      signinApprovalId: "sa-1",
    });
  });

  it("reads an approval the platform no longer knows as expired", async () => {
    const { vault } = client({
      _getAbacusbotPaymentApproval: {
        status: 404,
        body: { success: false, error: "payment approval not found" },
      },
    });

    expect(await vault.paymentApprovalStatus("pay-1")).toEqual({
      ok: true,
      value: { status: "expired" },
    });
  });
});
