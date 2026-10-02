import { beforeEach, expect, it, vi } from "vitest";

import type { Transport } from "#renderer/data/transport";

import { startFirstRunGmail, startWebsiteSignIn } from "./first-run";

beforeEach(() => localStorage.clear());
const setup = () => {
  const connect = vi.fn(async () => ({ ok: true }));
  const funnelStep = vi.fn(async () => {});
  const transport = {
    client: {
      connectors: { statuses: async () => ({}), connect },
      auth: { abacus: { shouldAutoSignIn: async () => true } },
      system: { funnelStep },
    },
  } as unknown as Transport;
  return { transport, connect, funnelStep };
};

it("starts Gmail consent once, for the authenticated address, and keeps ownership across screens", async () => {
  const { transport, connect, funnelStep } = setup();
  await Promise.all([
    startFirstRunGmail(transport, "ada@example.com"),
    startFirstRunGmail(transport, "ada@example.com"),
  ]);
  expect(connect).toHaveBeenCalledExactlyOnceWith({
    connectorId: "abacus-gmailuser",
    options: { autostart: true, hint: "ada@example.com", owner: "first-run" },
  });
  await vi.waitFor(() =>
    expect(funnelStep).toHaveBeenCalledWith({ step: "gmail_allowed" })
  );
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
