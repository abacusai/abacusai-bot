import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("../config/settings", () => ({
  hasCredential: () => true,
  readSettings: () => ({ apiKeys: { ABACUS_API_KEY: "test-key" } }),
}));

vi.mock("./abacus-host", () => ({
  abacusRoutellmV1: () => "https://routellm.example/v1",
  abacusUserAgent: () => "test-agent",
}));

vi.stubGlobal("fetch", fetchMock);

const { abacusCredentialRejected, clearAbacusCache, fetchAbacusAccount } =
  await import("./abacus");

beforeEach(() => {
  fetchMock.mockReset();
  clearAbacusCache();
});

describe("fetchAbacusAccount", () => {
  it("recognizes a valid session when the optional account endpoint is absent", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response('{"data":[]}', { status: 200 }));

    await expect(fetchAbacusAccount(true)).resolves.toEqual({
      user_id: null,
      organization_id: null,
      name: null,
      email: null,
      picture: null,
      organization: null,
      org_user_count: null,
      plan: null,
      subscription_tier: null,
      credits_used: null,
      credits_granted: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not describe an invalid key as connected", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

    await expect(fetchAbacusAccount(true)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("converts the authenticated profile picture for the CSP-isolated renderer", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: "Ada",
            email: "ada@example.com",
            picture: "https://images.example/ada.png",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        })
      );

    await expect(fetchAbacusAccount(true)).resolves.toMatchObject({
      name: "Ada",
      picture: "data:image/png;base64,AQID",
    });
  });

  it("keeps stable user and organization ids for profile scoping", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user_id: 42,
          organization_id: "org-9",
          email: "ada@example.com",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await expect(fetchAbacusAccount(true)).resolves.toMatchObject({
      user_id: "42",
      organization_id: "org-9",
    });
  });
});

/**
 * Telling "the key is over" apart from "ask again later".
 *
 * The app reads a stored key as proof of a session, so a key the platform has
 * revoked leaves it insisting the user is signed in while every request fails.
 * Acting on that requires knowing the difference between a refusal and a bad
 * afternoon on the network, and getting it backwards would sign people out
 * because their wifi dropped.
 */
describe("whether the key has been refused outright", () => {
  it("says no before anything has been asked", () => {
    expect(abacusCredentialRejected()).toBe(false);
  });

  it.each([401, 403])("says yes on %i", async (status) => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status }));

    await fetchAbacusAccount(true);

    expect(abacusCredentialRejected()).toBe(true);
  });

  it.each([500, 502, 429])(
    "says no on %i, which is the server having a bad day",
    async (status) => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status }));

      await fetchAbacusAccount(true);

      expect(abacusCredentialRejected()).toBe(false);
    }
  );

  it("says no when the request never arrives", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ETIMEDOUT"));

    await fetchAbacusAccount(true);

    expect(abacusCredentialRejected()).toBe(false);
  });

  it("forgets the verdict when the key changes", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await fetchAbacusAccount(true);
    expect(abacusCredentialRejected()).toBe(true);

    // A new key deserves its own answer.
    clearAbacusCache();

    expect(abacusCredentialRejected()).toBe(false);
  });

  it("does not keep serving a cached profile for a key that is now refused", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ name: "Ada" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    await expect(fetchAbacusAccount(true)).resolves.toMatchObject({
      name: "Ada",
    });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));

    await expect(fetchAbacusAccount(true)).resolves.toBeNull();
  });
});
