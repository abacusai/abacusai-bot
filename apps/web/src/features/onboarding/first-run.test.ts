import { beforeEach, expect, it, vi } from "vitest";

import type { Transport } from "#renderer/data/transport";

import { startWebsiteSignIn } from "./first-run";

beforeEach(() => localStorage.clear());
const setup = () => {
  const funnelStep = vi.fn(async () => {});
  const transport = {
    state: "open",
    client: {
      auth: { abacus: { shouldAutoSignIn: async () => true } },
      system: { funnelStep },
    },
  } as unknown as Transport;
  return { transport, funnelStep };
};

it("does not restart a cancelled website-account sign-in after remount or sign-out", async () => {
  const { transport } = setup();
  const start = vi.fn();
  await startWebsiteSignIn(transport, start);
  await startWebsiteSignIn(transport, start);
  expect(start).toHaveBeenCalledOnce();
});
