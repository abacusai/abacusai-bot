import { expect, it, vi } from "vitest";

import { connectInProcess, fakeDeps } from "./testing";

it("connects the first-run Gmail by connector id through the typed transport", async () => {
  const connectConnector = vi.fn(async () => ({ ok: true as const }));
  const shouldAutoSignIn = vi.fn(async () => true);
  const connection = connectInProcess(
    fakeDeps({ serviceHost: { connectConnector }, host: { shouldAutoSignIn } })
  );
  try {
    await connection.client.connectors.connect({
      connectorId: "abacus-gmailuser",
    });
    expect(connectConnector).toHaveBeenCalledWith("abacus-gmailuser");
    await expect(
      connection.client.auth.abacus.shouldAutoSignIn({})
    ).resolves.toBe(true);
  } finally {
    connection.closeClient();
    connection.closeServer();
  }
});
