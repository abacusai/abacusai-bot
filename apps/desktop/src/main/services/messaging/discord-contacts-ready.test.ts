/**
 * Discord's chat list is not believed until the rail has actually rendered.
 *
 * The report: "I checked the Discord address book properly this time, and
 * there are no contacts" — said ten seconds after connect, five seconds
 * before the rail read found two DMs.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => ({}) },
  shell: { openExternal: async () => undefined },
}));

const { DiscordWebConnector } = await import("./discord-web-connector");

const connectorWith = (answers: Array<unknown[] | null>) => {
  const connector = new DiscordWebConnector({
    onMessage: () => {},
    onState: () => {},
    onLog: () => {},
  } as never);
  const queue = [...answers];
  const internals = connector as unknown as {
    run: (script: string) => Promise<unknown>;
    refreshContacts: () => Promise<void>;
  };
  internals.run = async () => queue.shift() ?? null;
  return { connector, refresh: () => internals.refreshContacts() };
};

describe("when the Discord chat list can be believed", () => {
  it("not after a read that saw no DM home, nor after one empty rail", async () => {
    const { connector, refresh } = connectorWith([null, []]);
    await refresh();
    expect(connector.contactsReady()).toBe(false);
    await refresh();
    expect(connector.contactsReady()).toBe(false);
  });

  it("after the rail shows DMs", async () => {
    const { connector, refresh } = connectorWith([
      [{ chatId: "1", name: "anewja" }],
    ]);
    await refresh();
    expect(connector.contactsReady()).toBe(true);
    expect(connector.listContacts()).toEqual([{ chatId: "1", name: "anewja" }]);
  });

  it("after two empty rails — an account with no DMs is also an answer", async () => {
    const { connector, refresh } = connectorWith([[], []]);
    await refresh();
    await refresh();
    expect(connector.contactsReady()).toBe(true);
  });
});
