import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("../config/settings", () => ({
  hasCredential: () => true,
  credentialFor: (name: string) =>
    name === "ABACUS_API_KEY" ? "test-key" : "",
}));

vi.mock("./abacus-host", () => ({
  abacusRoutellmV1: () => "https://routellm.example/v1",
  abacusUserAgent: () => "test-agent",
}));

vi.stubGlobal("fetch", fetchMock);

const {
  abacusCredentialRejected,
  abacusPaymentRequired,
  cachedAbacusModels,
  clearAbacusCache,
  fetchAbacusAccount,
  fetchAbacusModels,
  onAbacusPaymentChange,
} = await import("./abacus");
const { ConnectivityService } =
  await import("../connectivity/connectivity-service");

beforeEach(() => {
  fetchMock.mockReset();
  clearAbacusCache();
});

describe("fetchAbacusAccount", () => {
  it("keeps the last known free tier during a transient account failure", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ subscription_tier: "free" }), {
        status: 200,
      })
    );
    await expect(fetchAbacusAccount(true)).resolves.toMatchObject({
      subscription_tier: "free",
    });
    fetchMock.mockRejectedValueOnce(new Error("ETIMEDOUT"));
    await expect(fetchAbacusAccount(true)).resolves.toMatchObject({
      subscription_tier: "free",
    });
  });

  it("rechecks the tier after credential adoption clears the previous account", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ subscription_tier: "free" }), {
        status: 200,
      })
    );
    await fetchAbacusAccount();
    clearAbacusCache();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ subscription_tier: "pro" }), {
        status: 200,
      })
    );
    await expect(fetchAbacusAccount()).resolves.toMatchObject({
      subscription_tier: "pro",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

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

  it("says the free credits are held only when the server does", async () => {
    const read = async (body: Record<string, unknown>) => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ credits_granted: 2000, ...body }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
      return fetchAbacusAccount(true);
    };
    expect((await read({ free_credits_held: true }))?.free_credits_held).toBe(
      true
    );
    expect((await read({ free_credits_held: false }))?.free_credits_held).toBe(
      false
    );
    // An older server sends nothing: neither held nor unlocked.
    expect(await read({})).not.toHaveProperty("free_credits_held");
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

/**
 * The payment gate's 402: the key is good, the account has to pay. It is
 * neither a refused key (no sign-out) nor a blip (no stale profile).
 */
describe("an account the payment gate refuses", () => {
  const refusal = (reason?: string) =>
    new Response(
      JSON.stringify({
        success: false,
        error: "Payment required",
        errorType: "PaymentMethodRequired",
        ...(reason == null ? {} : { reason, abacusaibotOnly: true }),
      }),
      { status: 402 }
    );

  it.each(["unconfirmed", "trial_ended", "lapsed"] as const)(
    "is signed in but must pay (%s), and the key is not refused",
    async (reason) => {
      fetchMock.mockResolvedValueOnce(refusal(reason));

      await expect(fetchAbacusAccount(true)).resolves.toBeNull();

      expect(abacusPaymentRequired()).toEqual({ reason });
      expect(abacusCredentialRejected()).toBe(false);
    }
  );

  it("has no reason from a server that sends none", async () => {
    fetchMock.mockResolvedValueOnce(refusal());

    await fetchAbacusAccount(true);

    expect(abacusPaymentRequired()).toEqual({ reason: null });
  });

  it("keeps 401 and 403 as a refused key, not a payment", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

    await fetchAbacusAccount(true);

    expect(abacusCredentialRejected()).toBe(true);
    expect(abacusPaymentRequired()).toBeNull();
  });

  it("does not keep serving the profile it had before the refusal", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ name: "Ada" }), { status: 200 })
    );
    await fetchAbacusAccount(true);
    fetchMock.mockResolvedValueOnce(refusal("lapsed"));

    await expect(fetchAbacusAccount(true)).resolves.toBeNull();
    await expect(fetchAbacusAccount()).resolves.toBeNull();
  });

  it("offers no Abacus model while the account must pay", async () => {
    fetchMock.mockResolvedValueOnce(refusal("trial_ended"));

    await expect(fetchAbacusModels()).resolves.toEqual([]);

    expect(abacusPaymentRequired()).toEqual({ reason: "trial_ended" });
    expect(cachedAbacusModels()).toEqual([]);
  });

  it("is over once the account pays, and says so once per change", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await fetchAbacusAccount(true);
    const heard = vi.fn();
    const stop = onAbacusPaymentChange(heard);
    fetchMock.mockResolvedValueOnce(refusal("trial_ended"));
    await fetchAbacusAccount(true);
    // A key change clears the verdict; the same answer again is not news.
    clearAbacusCache();
    fetchMock.mockResolvedValueOnce(refusal("trial_ended"));
    await fetchAbacusAccount(true);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ subscription_tier: "basic" }), {
        status: 200,
      })
    );

    await expect(fetchAbacusAccount(true)).resolves.toMatchObject({
      subscription_tier: "basic",
    });

    expect(abacusPaymentRequired()).toBeNull();
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("fetchAbacusModels without a network", () => {
  it("offers the account's last fetched list after a restart", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-abacus-"));
    vi.stubEnv("ABACUSAI_BOT_HOME", home);
    try {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { id: "model-a", model_type: "text_generation", agentic: true },
            ],
          }),
          { status: 200 }
        )
      );
      const live = await fetchAbacusModels();
      expect(live.map((model) => model.id)).toEqual(["abacus/model-a"]);

      // A new process: nothing cached in memory, and the network is gone.
      clearAbacusCache();
      fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
      expect(await fetchAbacusModels()).toEqual(live);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

/** The connectivity owner: the OS's answer, sleep and wake, and a probe of the Abacus API. */
describe("connectivity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const service = (options: { reachable?: boolean } = {}) => {
    const probe = vi.fn(async () => options.reachable ?? true);
    const changes: Array<{ state: string; resumed: boolean }> = [];
    const connectivity = new ConnectivityService({
      probe,
      internet: async () => true,
    });
    connectivity.onChange((change) => changes.push(change));
    return { connectivity, probe, changes };
  };

  describe("the connectivity owner", () => {
    it("goes offline the moment the OS says so, without a probe", async () => {
      let osOnline = true;
      const { connectivity, probe, changes } = service();
      connectivity.start(() => osOnline);
      expect(connectivity.state).toBe("online");

      osOnline = false;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(connectivity.state).toBe("offline");
      expect(changes).toEqual([{ state: "offline", resumed: false }]);
      expect(probe).not.toHaveBeenCalled();
      connectivity.stop();
    });

    it("probes when the OS has a network again, and says online once Abacus answers", async () => {
      let osOnline = false;
      const { connectivity, probe, changes } = service();
      connectivity.start(() => osOnline);
      expect(connectivity.state).toBe("offline");

      osOnline = true;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(probe).toHaveBeenCalled();
      expect(connectivity.state).toBe("online");
      expect(changes.at(-1)).toEqual({ state: "online", resumed: false });
      connectivity.stop();
    });

    it("is degraded when the OS has a network but Abacus does not answer, and backs off", async () => {
      const { connectivity, probe } = service({ reachable: false });

      connectivity.reportFailure();
      await vi.advanceTimersByTimeAsync(0);
      expect(connectivity.state).toBe("degraded");
      expect(probe).toHaveBeenCalledTimes(1);

      // 10s, 20s, 40s: never a hot loop.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(probe).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(19_000);
      expect(probe).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(probe).toHaveBeenCalledTimes(3);
      connectivity.stop();
    });

    it("does not probe while online with nothing reported", async () => {
      const { connectivity, probe } = service();
      connectivity.start(() => true);

      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(probe).not.toHaveBeenCalled();
      connectivity.stop();
    });

    it("says so on wake, even when the state did not move", async () => {
      const { connectivity, changes } = service();

      connectivity.suspended();
      connectivity.resumed();
      await vi.advanceTimersByTimeAsync(0);

      expect(changes).toEqual([{ state: "online", resumed: true }]);
    });

    it("answers a caller about to need the network from a fresh probe", async () => {
      const { connectivity, probe } = service({ reachable: false });

      expect(await connectivity.ensureFresh()).toBe("degraded");
      expect(probe).toHaveBeenCalledTimes(1);
      connectivity.stop();
    });
  });
});

describe("a model the plan refused", () => {
  const freeAccount = (tier: string) =>
    new Response(JSON.stringify({ subscription_tier: tier }), { status: 200 });

  it("stays locked across a catalog refresh and a restart, and lifts on a new plan", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-abacus-"));
    vi.stubEnv("ABACUSAI_BOT_HOME", home);
    try {
      fetchMock.mockResolvedValueOnce(freeAccount("free"));
      await fetchAbacusAccount(true);
      const { lockAbacusModelForPlan, planLockedAbacusIds, planRefusedModel } =
        await import("./abacus");
      const model = planRefusedModel({
        actions: [
          { type: "switch-model" },
          { type: "model-unavailable", cause: "plan", model: "abacus/paid" },
        ],
      });
      expect(model).toBe("abacus/paid");
      expect(
        planRefusedModel({ actions: [{ type: "upgrade-abacus" }] })
      ).toBeNull();
      // A retired or failing model is not locked: only the plan's refusal.
      expect(
        planRefusedModel({
          actions: [
            { type: "model-unavailable", cause: "retired", model: "abacus/x" },
          ],
        })
      ).toBeNull();
      lockAbacusModelForPlan(model!);
      // Only Abacus ids: another provider's model is its key's business.
      lockAbacusModelForPlan("openai/gpt");
      expect([...planLockedAbacusIds()]).toEqual(["abacus/paid"]);

      // A refresh drops the caches, not what the platform refused.
      clearAbacusCache();
      fetchMock.mockResolvedValueOnce(freeAccount("free"));
      await fetchAbacusAccount(true);
      expect([...planLockedAbacusIds()]).toEqual(["abacus/paid"]);

      // A new process reads it back from disk.
      vi.resetModules();
      const restarted = await import("./abacus");
      fetchMock.mockResolvedValueOnce(freeAccount("free"));
      await restarted.fetchAbacusAccount(true);
      expect([...restarted.planLockedAbacusIds()]).toEqual(["abacus/paid"]);

      // The upgrade: the plan changed, so the lock is lifted.
      fetchMock.mockResolvedValueOnce(freeAccount("basic"));
      await restarted.fetchAbacusAccount(true);
      expect(restarted.planLockedAbacusIds().size).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
