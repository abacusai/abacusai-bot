/**
 * The shared bots' inbox is one queue per account, not one per channel.
 * With Discord and Telegram both linked, each lane's poll drained the whole
 * queue, and a Telegram message came in through whichever poll returned
 * first and was logged, routed and answered as Discord. An entry now reaches the
 * lane its channel names, whichever lane fetched it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  shell: { openExternal: vi.fn() },
}));
vi.mock("../../bring-to-front", () => ({ parentWindow: () => undefined }));
vi.mock("../providers/abacus", () => ({ resolveAbacusApiKey: () => "key" }));
vi.mock("../providers/abacus-host", () => ({
  abacusRoutellmV1: () => "https://example.test/v1",
  abacusUserAgent: () => "test",
}));
vi.mock("./discord-web-connector", () => ({
  DISCORD_PARTITION: "persist:discord-web",
}));

const { AbacusChannelsConnector } = await import("./abacus-channels-connector");

type Delivered = { lane: string; text: string; from: string | null };
type Entry = {
  id: string;
  ts: number;
  channel: string;
  sender: string | null;
  text: string;
};
type Lane = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  route: (entry: Entry) => void;
};

// Every call answers "available, nothing linked": start() registers the lane
// and its poll then idles on the pairing interval instead of the inbox.
const requests: Array<Record<string, unknown>> = [];
globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
  requests.push(JSON.parse(String(init?.body ?? "{}")));
  return new Response(
    JSON.stringify({ available: ["discord", "telegram"], channels: {} }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}) as unknown as typeof fetch;

const started: Lane[] = [];
const lane = async (
  channel: "discord" | "telegram",
  delivered: Delivered[],
  logs: string[]
): Promise<Lane> => {
  const connector = new AbacusChannelsConnector(
    {
      onMessage: (message) =>
        delivered.push({
          lane: channel,
          text: message.text,
          from: message.userName,
        }),
      onState: () => {},
      onLog: (line) => logs.push(line),
    },
    channel
  ) as unknown as Lane;
  await connector.start();
  started.push(connector);
  return connector;
};

afterEach(async () => {
  for (const connector of started.splice(0)) await connector.stop();
});

const entry = (channel: string, text: string): Entry => ({
  id: `${channel}-${text}`,
  ts: 1,
  channel,
  sender: "S",
  text,
});

describe("an inbox entry", () => {
  it("reaches the lane its channel names, whichever lane fetched it", async () => {
    const delivered: Delivered[] = [];
    const logs: string[] = [];
    const discord = await lane("discord", delivered, logs);
    await lane("telegram", delivered, logs);

    discord.route(entry("telegram", "Love u"));
    discord.route(entry("discord", "Hey"));

    expect(delivered).toEqual([
      { lane: "telegram", text: "Love u", from: "S" },
      { lane: "discord", text: "Hey", from: "S" },
    ]);
    expect(logs.filter((line) => line.includes("no telegram lane"))).toEqual(
      []
    );
  });

  it("is delivered by the fetching lane, and said so, when its lane is not running", async () => {
    const delivered: Delivered[] = [];
    const logs: string[] = [];
    const discord = await lane("discord", delivered, logs);

    discord.route(entry("telegram", "Love u"));

    expect(delivered).toEqual([{ lane: "discord", text: "Love u", from: "S" }]);
    expect(logs.some((line) => line.includes("no telegram lane running"))).toBe(
      true
    );
  });

  it("stays with the fetching lane when the entry names no channel", async () => {
    const delivered: Delivered[] = [];
    const discord = await lane("discord", delivered, []);
    await lane("telegram", delivered, []);

    discord.route({ ...entry("discord", "Hey"), channel: "" });

    expect(delivered).toEqual([{ lane: "discord", text: "Hey", from: "S" }]);
  });
});
