import { afterEach, expect, it, vi } from "vitest";

import {
  connectInProcess,
  fakeDeps,
  type InProcessConnection,
} from "../testing";

const connections: InProcessConnection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) {
    connection.closeClient();
    connection.closeServer();
  }
});
const setup = (context: Parameters<typeof connectInProcess>[1] = {}) => {
  const erase = vi.fn();
  const connection = connectInProcess(
    fakeDeps({
      app: { deleteAllData: erase },
      windows: { mainRendererId: () => 42 },
    }),
    {
      transport: "message-port",
      windowKind: "main",
      webContentsId: 42,
      ...context,
    }
  );
  connections.push(connection);
  return { client: connection.client, erase };
};

it("accepts only explicit confirmation from the local main renderer", async () => {
  const { client, erase } = setup();
  for (const input of [
    {},
    { confirmation: false },
    { confirmation: "DELETE" },
    { confirmation: "DELETE_ALL_LOCAL_DATA", path: "/" },
  ])
    await expect(
      client.system.deleteAllData(input as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(erase).not.toHaveBeenCalled();
  await client.system.deleteAllData({ confirmation: "DELETE_ALL_LOCAL_DATA" });
  expect(erase).toHaveBeenCalledOnce();
});

it.each([
  { platform: "web-host" as const },
  { transport: "websocket" as const },
  { windowKind: "notch" as const },
  { webContentsId: 43 },
  { webContentsId: null },
])("refuses a nonlocal or nonmain caller: %j", async (context) => {
  const { client, erase } = setup(context);
  await expect(
    client.system.deleteAllData({ confirmation: "DELETE_ALL_LOCAL_DATA" })
  ).rejects.toMatchObject({
    code: context.platform ? "UNSUPPORTED" : "FORBIDDEN",
  });
  expect(erase).not.toHaveBeenCalled();
});
