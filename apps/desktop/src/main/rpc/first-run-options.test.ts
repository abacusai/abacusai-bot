import { expect, it, vi } from "vitest";

import { connectInProcess, fakeDeps } from "./testing";

it("passes first-run Gmail consent options through the typed transport", async () => {
  const connectConnector = vi.fn(async () => ({ ok: true as const }));
  const shouldAutoSignIn = vi.fn(async () => true);
  const connection = connectInProcess(
    fakeDeps({ serviceHost: { connectConnector }, host: { shouldAutoSignIn } })
  );
  try {
    const options = {
      autostart: true,
      hint: "person@example.com",
      owner: "first-run" as const,
    };
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
