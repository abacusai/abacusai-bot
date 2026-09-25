/**
 * Discord reads are bounded: a read that would only queue behind other reads
 * says so at once, and one that is admitted cannot run past the deadline.
 *
 * The report: read_chat_messages on Discord taking over a minute with two
 * channels' bots reading at once. Each read drives the page, the page does
 * one thing at a time, and nothing bounded the wait. Sends are untouched.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => ({}) },
  shell: { openExternal: async () => undefined },
}));

const { DiscordWebConnector } = await import("./discord-web-connector");

type Internals = {
  loggedIn: boolean;
  readDeadlineMs: number;
  readChatNow: () => Promise<unknown[]>;
  sendTextNow: () => Promise<void>;
};

const connectorWith = (
  work: () => Promise<void>
): { connector: InstanceType<typeof DiscordWebConnector>; logs: string[] } => {
  const logs: string[] = [];
  const connector = new DiscordWebConnector({
    onMessage: () => {},
    onState: () => {},
    onLog: (line: string) => logs.push(line),
  } as never);
  const internals = connector as unknown as Internals;
  internals.loggedIn = true;
  internals.readChatNow = async () => {
    await work();
    return [];
  };
  internals.sendTextNow = async () => {
    await work();
  };
  return { connector, logs };
};

describe("reads while the page is busy", () => {
  it("fail fast past the queue limit; sends still queue", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { connector } = connectorWith(() => gate);

    // Two reads hold the page; the third is refused immediately.
    const first = connector.readChat("123/456", 10);
    const second = connector.readChat("123/457", 10);
    await expect(connector.readChat("123/458", 10)).rejects.toThrow(
      /busy with another chat/
    );
    // A send is never turned away; it waits its turn.
    const sent = connector.sendText("123/456", "hi");

    release();
    await Promise.all([first, second, sent]);
  });

  it("give up at the deadline, and say so, rather than waiting a minute", async () => {
    const { connector, logs } = connectorWith(() => new Promise(() => {}));
    (connector as unknown as Internals).readDeadlineMs = 300;
    const started = Date.now();

    await expect(connector.readChat("123/456", 10)).rejects.toThrow(
      /did not finish the live read/
    );

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(logs.join("\n")).toMatch(/did not finish within/);
  });

  it("answer normally when the page is free", async () => {
    const { connector } = connectorWith(async () => {});
    await expect(connector.readChat("123/456", 10)).resolves.toEqual([]);
  });
});
