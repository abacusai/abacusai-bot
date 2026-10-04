import { expect, it, vi } from "vitest";

import type { Db } from "#renderer/data/db";
import type { Transport } from "#renderer/data/transport";

import { connectOnboarding } from "./connect";

it("R6-T8 messaging enables and queues once without entering the pairing flow", async () => {
  const updatePlatform = vi.fn(async () => ({}));
  const connect = vi.fn();
  let queue: string[] = [];
  const db = {
    collections: { prefs: { get: () => ({ onboardingPairing: queue }) } },
    updatePrefs: vi.fn(async (patch) => {
      queue = patch.onboardingPairing;
    }),
  } as unknown as Db;
  const transport = {
    client: { messaging: { updatePlatform }, connectors: { connect } },
  } as unknown as Transport;
  expect(await connectOnboarding(db, transport, "messaging-discord")).toEqual({
    ok: false,
    deferred: true,
  });
  await connectOnboarding(db, transport, "messaging-discord");
  expect(queue).toEqual(["discord"]);
  expect(updatePlatform).toHaveBeenCalledWith({
    platformId: "discord",
    enabled: true,
  });
  expect(connect).not.toHaveBeenCalled();
});
