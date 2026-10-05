/**
 * The sign-in gate in the Electron build (spec 09 D12 keeps desktop
 * behaviour): nothing is remembered, so every gate decides from fresh state;
 * onboarding asks for the settings only of an onboarded account (a failing
 * settings call cannot keep a new user out of onboarding); writes are never
 * held by a MessagePort. The route trees' gate runs in this build through
 * the phase route suites (`routes/-phase5`, `-phase6`).
 */
import { contract } from "@abacus-ai/contract/contract";
import { ORPCError } from "@orpc/client";
import { implement } from "@orpc/server";
import { afterEach, expect, it } from "vitest";

import { createQueryClient } from "#renderer/data/query-client";
import { createMemoryTransport } from "#renderer/data/transport/memory";

import { accountStateQuery } from "./actions";
import { keep, leave, readGate } from "./gate";

const os = implement(contract);

const gateHost = (initial: boolean, signedIn = false) => {
  const calls: string[] = [];
  const flags = { onboarded: initial, signedIn };
  const transport = createMemoryTransport(
    {
      account: {
        state: os.account.state.handler(() => {
          calls.push("account.state");
          return { account: null, apps: [], onboarded: flags.onboarded };
        }),
      },
      settings: {
        get: os.settings.get.handler(() => {
          calls.push("settings.get");
          if (flags.signedIn)
            return {
              defaultModel: null,
              apiKeys: { ABACUS_API_KEY: "credential" },
            } as never;
          throw new ORPCError("INTERNAL_SERVER_ERROR", {
            message: "settings unavailable",
          });
        }),
      },
    } as never,
    {}
  );
  return { calls, flags, transport, queryClient: createQueryClient() };
};

let cleanup: (() => Promise<void> | void) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

it("lets a user who is not onboarded into onboarding without asking for settings", async () => {
  const host = gateHost(false);
  cleanup = () => host.transport.close();
  const gate = readGate(host, "onboarding");
  expect(gate).not.toBeNull();
  await expect(gate).resolves.toMatchObject({
    account: { onboarded: false },
    signedIn: false,
  });
  expect(host.calls).toEqual(["account.state"]);
});

it("asks for settings for an onboarded account, and fails with them", async () => {
  const host = gateHost(true);
  cleanup = () => host.transport.close();
  await expect(readGate(host, "onboarding")).rejects.toBeDefined();
  expect(host.calls).toEqual(["account.state", "settings.get"]);
});

it("never renders provisionally: a MessagePort is open, keep and leave hold nothing", async () => {
  const host = gateHost(false);
  cleanup = () => host.transport.close();
  // The shell always asks the host (here: its settings fail).
  await expect(readGate(host, "shell")).rejects.toBeDefined();
  await readGate(host, "onboarding");
  expect(() => keep(host, "onboarding", { ticket: 0 })).not.toThrow();
  expect(() => leave(host, "/settings")).not.toThrow();
});

/** The cached answer, invalidated with nothing observing it (a recovery). */
const invalidate = (host: ReturnType<typeof gateHost>) =>
  host.queryClient.invalidateQueries({
    queryKey: accountStateQuery(host.transport).queryKey,
  });

it("asks the host again for an invalidated account answer nothing observes: onboarding done elsewhere", async () => {
  const host = gateHost(false, true);
  cleanup = () => host.transport.close();
  await expect(readGate(host, "onboarding")).resolves.toMatchObject({
    account: { onboarded: false },
  });
  host.flags.onboarded = true;
  await invalidate(host);
  await expect(readGate(host, "onboarding")).resolves.toMatchObject({
    account: { onboarded: true },
    signedIn: true,
  });
  expect(host.calls.filter((call) => call === "account.state")).toHaveLength(2);
});

it("asks the host again for an invalidated account answer: onboarding reset elsewhere", async () => {
  const host = gateHost(true, true);
  cleanup = () => host.transport.close();
  await expect(readGate(host, "shell")).resolves.toMatchObject({
    account: { onboarded: true },
  });
  host.flags.onboarded = false;
  await invalidate(host);
  await expect(readGate(host, "shell")).resolves.toMatchObject({
    account: { onboarded: false },
  });
  // Still the cached path while nothing invalidated it.
  await readGate(host, "shell");
  expect(host.calls.filter((call) => call === "account.state")).toHaveLength(2);
});
