/**
 * The plan reaches every agent as the account names it: the tier from the
 * account, the plan's name only when it names that tier. A payment patches
 * the tier before the read that renames the plan, so "Free" must not ride
 * along with Basic.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

vi.mock("electron", () => {
  const anything: unknown = new Proxy(function () {}, {
    get: (_target, key) => (key === "then" ? undefined : anything),
    apply: () => anything,
    construct: () => anything as object,
  });
  return new Proxy(
    {
      default: anything,
      app: {
        isPackaged: false,
        getPath: () => process.env.ABACUSAI_BOT_HOME,
        getVersion: () => "1.0.86",
        getLocale: () => "en-US",
        getPreferredSystemLanguages: () => ["en-US"],
      },
    },
    {
      get: (target, key) =>
        key in target
          ? (target as Record<PropertyKey, unknown>)[key]
          : key === "then"
            ? undefined
            : anything,
      has: () => true,
    }
  );
});
vi.mock("electron-store", () => ({
  default: class {
    private values: Record<string, unknown>;
    constructor(options: { defaults?: Record<string, unknown> } = {}) {
      this.values = { ...options.defaults };
    }
    get(key: string, fallback?: unknown) {
      return this.values[key] ?? fallback;
    }
    set(key: string, value: unknown) {
      this.values[key] = value;
    }
    delete(key: string) {
      delete this.values[key];
    }
    onDidChange() {
      return () => {};
    }
  },
}));

vi.mock("../config/settings", async (importActual) => ({
  ...(await importActual<typeof import("../config/settings")>()),
  hasCredential: () => true,
  credentialFor: (name: string) =>
    name === "ABACUS_API_KEY" ? "test-key" : "",
}));

const { accountMovedPlan, accountPlan, clearAbacusCache, fetchAbacusAccount } =
  await import("./abacus");
const { ServiceHost } = await import("../../service-host");

const account = (tier: string, plan: string): Response =>
  new Response(JSON.stringify({ subscription_tier: tier, plan }), {
    status: 200,
  });

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "account-plan-"));
  vi.stubEnv("ABACUSAI_BOT_HOME", home);
  fetchMock.mockReset();
  clearAbacusCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

it("tells every agent the plan after each account read, as accountPlan() reads it", async () => {
  const host = new ServiceHost();
  const internals = host as unknown as Record<string, any>;
  const broadcast = vi
    .spyOn(internals.agentManagerService, "broadcastCommand")
    .mockReturnValue(0);
  const plans = () =>
    broadcast.mock.calls
      .map(([command]) => command as { type: string })
      .filter((command) => command.type === "account_plan");

  fetchMock.mockResolvedValueOnce(account("pro", "Pro"));
  await fetchAbacusAccount(true);

  expect(plans()).toEqual([{ type: "account_plan", ...accountPlan() }]);
  expect(accountPlan()).toEqual({ tier: "paid", name: "Pro" });
});

it("drops the old plan's name when a payment moves free to Basic, until the read renames it", async () => {
  const host = new ServiceHost();
  const internals = host as unknown as Record<string, any>;
  const broadcast = vi
    .spyOn(internals.agentManagerService, "broadcastCommand")
    .mockReturnValue(0);
  fetchMock.mockResolvedValueOnce(account("free", "Free"));
  await fetchAbacusAccount(true);
  expect(accountPlan()).toEqual({ tier: "free", name: "Free" });
  broadcast.mockClear();

  let release: () => void = () => {};
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(account("basic", "Basic"));
      })
  );
  accountMovedPlan("basic");

  // The tier moved at once; "Free" no longer names it.
  expect(broadcast).toHaveBeenCalledWith({
    type: "account_plan",
    tier: "basic",
    name: null,
  });
  release();
  await vi.waitFor(() =>
    expect(broadcast).toHaveBeenLastCalledWith({
      type: "account_plan",
      tier: "basic",
      name: "Basic",
    })
  );
  const named = broadcast.mock.calls
    .map(([command]) => command as { type: string; name?: unknown })
    .filter((command) => command.type === "account_plan");
  expect(named.some((command) => command.name === "Free")).toBe(false);
});
