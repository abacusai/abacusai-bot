import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Transport } from "#renderer/data/transport";

import { startFirstRunGmail, startWebsiteSignIn } from "./first-run";

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());
const setup = () => {
  const connect = vi.fn(async () => ({
    ok: true,
    url: "https://apps.example/chatllm/connect-connector?service=gmailuser",
  }));
  const funnelStep = vi.fn(async () => {});
  const openExternal = vi.fn(async () => {});
  const statuses = vi.fn(async () => ({}));
  const transport = {
    client: {
      connectors: { statuses, connect },
      auth: { abacus: { shouldAutoSignIn: async () => true } },
      system: { funnelStep, openExternal },
    },
  } as unknown as Transport;
  return { transport, connect, funnelStep, openExternal, statuses };
};

it("opens Gmail's connect page once, for the authenticated address, and reports once connected", async () => {
  vi.useFakeTimers();
  const { transport, connect, funnelStep, openExternal, statuses } = setup();
  await Promise.all([
    startFirstRunGmail(transport, "ada@example.com"),
    startFirstRunGmail(transport, "ada@example.com"),
  ]);
  expect(connect).toHaveBeenCalledExactlyOnceWith({
    connectorId: "abacus-gmailuser",
    options: { hint: "ada@example.com" },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(openExternal).toHaveBeenCalledExactlyOnceWith({
    url: "https://apps.example/chatllm/connect-connector?service=gmailuser",
  });
  expect(funnelStep).not.toHaveBeenCalled();
  statuses.mockResolvedValue({
    "abacus-gmailuser": { state: "connected" },
  } as never);
  await vi.advanceTimersByTimeAsync(3000);
  expect(funnelStep).toHaveBeenCalledWith({ step: "gmail_allowed" });
});

it("does not open Gmail for a missing address or a connected account", async () => {
  const { transport, connect } = setup();
  await startFirstRunGmail(transport, "");
  transport.client.connectors.statuses = async () => ({
    "abacus-gmailuser": { state: "connected" },
  });
  await startFirstRunGmail(transport, "ada@example.com");
  expect(connect).not.toHaveBeenCalled();
});

it("does not restart a cancelled website-account sign-in after remount or sign-out", async () => {
  const { transport } = setup();
  const start = vi.fn();
  await startWebsiteSignIn(transport, start);
  await startWebsiteSignIn(transport, start);
  expect(start).toHaveBeenCalledOnce();
});
