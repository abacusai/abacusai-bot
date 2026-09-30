import { expect, it, vi } from "vitest";

import { connectInProcess, fakeDeps } from "./testing";

it.each(["session", "bot", "routine"] as const)(
  "preserves %s routing metadata through system.notify and click events",
  async (kind) => {
    const showNotification = vi.fn();
    const deps = fakeDeps({ app: { showNotification } });
    const connection = connectInProcess(deps);
    const metadata = {
      kind,
      sessionId: "s",
      workspaceId: "w",
      botId: "b",
      routineId: "r",
    };
    try {
      await connection.client.system.notify({
        title: "Title",
        body: "Body",
        metadata,
      });
      expect(showNotification).toHaveBeenCalledWith("Title", "Body", metadata);
      const abort = new AbortController();
      const events = await connection.client.system.events(
        {},
        { signal: abort.signal }
      );
      const next = events[Symbol.asyncIterator]().next();
      deps.bus.dispatchChannel("system", {
        type: "notification-clicked",
        metadata,
      });
      expect((await next).value).toEqual({
        type: "notification-clicked",
        metadata,
      });
      abort.abort();
    } finally {
      connection.closeClient();
      connection.closeServer();
    }
  }
);

it("rejects an unknown notification owner before calling the producer", async () => {
  const showNotification = vi.fn();
  const connection = connectInProcess(fakeDeps({ app: { showNotification } }));
  try {
    await expect(
      connection.client.system.notify({
        title: "Title",
        body: "Body",
        metadata: { kind: "unknown" as never },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(showNotification).not.toHaveBeenCalled();
  } finally {
    connection.closeClient();
    connection.closeServer();
  }
});
