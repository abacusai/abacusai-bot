import { expect, it, vi } from "vitest";

import { connectInProcess, fakeDeps } from "./testing";

it("passes the first-run Gmail account hint through the typed transport", async () => {
  const connectConnector = vi.fn(async () => ({ ok: true as const }));
  const shouldAutoSignIn = vi.fn(async () => true);
  const connection = connectInProcess(
    fakeDeps({ serviceHost: { connectConnector }, host: { shouldAutoSignIn } })
  );
  try {
    const options = { hint: "person@example.com" };
    await connection.client.connectors.connect({
      connectorId: "abacus-gmailuser",
      options,
    });
    expect(connectConnector).toHaveBeenCalledWith("abacus-gmailuser", options);
    await expect(
      connection.client.auth.abacus.shouldAutoSignIn({})
    ).resolves.toBe(true);
  } finally {
    connection.closeClient();
    connection.closeServer();
  }
});
