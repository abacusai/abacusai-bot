/**
 * The shared Discord bot's own chat: Discord's "message the bot first"
 * refusal is told apart from a failed send, and the bot's chat stays one
 * click away after the app restarts.
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

const kept = vi.hoisted(() => new Map<string, string>());
vi.mock("./messaging-config-service", () => ({
  readPlatformBotProfileUrl: (id: string) => kept.get(id) ?? null,
  savePlatformBotProfileUrl: (id: string, url: string) => kept.set(id, url),
}));

const { AbacusChannelsConnector } = await import("./abacus-channels-connector");
const { FirstMessageNeededError } = await import("./connector");

const respond = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** What the server answers each action with. */
const answers: Record<string, unknown> = {};
globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
  const { action } = JSON.parse(String(init?.body)) as { action: string };
  return respond(answers[action] ?? {});
}) as unknown as typeof fetch;

const callbacks = {
  onState: () => {},
  onMessage: () => {},
  onLog: () => {},
};

afterEach(() => {
  kept.clear();
  for (const key of Object.keys(answers)) delete answers[key];
});

describe("the shared Discord bot's own chat", () => {
  it("throws Discord's first-message refusal as its own error, and any other failure as a plain one", async () => {
    const connector = new AbacusChannelsConnector(callbacks as never);
    const reason =
      "Discord will not deliver DMs from the agent until you message it on Discord first or share a server with it";
    answers.send = { ok: false, error: reason, code: "discord_dm_closed" };
    const refused = await connector.sendText("me", "Report").catch((e) => e);
    expect(refused).toBeInstanceOf(FirstMessageNeededError);
    expect(refused.message).toBe(reason);
    answers.reply = { ok: false, error: reason, code: "discord_dm_closed" };
    await expect(
      connector.sendText("me", "Report", { message_id: "m1" })
    ).rejects.toBeInstanceOf(FirstMessageNeededError);
    for (const answer of [
      { ok: false, error: "Discord did not accept the message" },
      // A server too old to send the code: its words alone are a plain failure.
      { ok: false, error: reason },
    ]) {
      answers.send = answer;
      const failed = await connector.sendText("me", "Report").catch((e) => e);
      expect(failed).toBeInstanceOf(Error);
      expect(failed).not.toBeInstanceOf(FirstMessageNeededError);
    }
  });

  it("keeps the bot's chat link from the pairing, so a restarted app can still open it", async () => {
    answers.pair = {
      status: "pending",
      deep_link:
        "https://discord.com/oauth2/authorize?client_id=123456&integration_type=1",
      code: "abc",
    };
    const pairing = new AbacusChannelsConnector(callbacks as never);
    await pairing.pair();
    await pairing.stop();
    // The next launch is linked already: it never pairs again.
    answers.status = {
      available: ["discord"],
      channels: { discord: { status: "linked", display_name: "me" } },
    };
    const restarted = new AbacusChannelsConnector(callbacks as never);
    await restarted.start();
    expect(restarted.linkUrl("dm")).toBe("https://discord.com/users/123456");
    await restarted.stop();
  });
});
