/**
 * Which model a bot's chat says it is running on.
 *
 * A bot pinned to `openllm/auto` showed the router for a moment and then
 * snapped onto whatever the pool resolved to — "DeepSeek V4 Flash" a few
 * seconds after the chat opened, as if something had silently changed the
 * bot's model behind the user's back. The session loop had the rule that
 * prevents this and the bot loop did not, so the two front ends disagreed
 * about the same question.
 *
 * The router is the choice; which model it lands on today is an
 * implementation detail. See `currentModelReference` in both loops.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FakeProvider } from "@abacus-ai/test-support/fake-provider";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type DesktopEvent } from "../protocol.js";
import { BotSession } from "./bot-session.js";

let provider: FakeProvider;
let home: string;
let botDir: string;

const openLlmConfig = (): string =>
  JSON.stringify({
    defaultModel: "openllm/auto",
    customProviders: [
      {
        id: "ollama",
        baseUrl: provider.baseUrl,
        apiKey: "test-key",
        models: [
          { id: "big", contextWindow: 131072 },
          { id: "small", contextWindow: 65536 },
        ],
      },
    ],
  });

/** A bot's chat wired to the fake provider, with everything it emitted. */
const botSession = (
  model?: string
): { session: BotSession; events: DesktopEvent[] } => {
  const events: DesktopEvent[] = [];
  const session = new BotSession({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-botchat-")),
    mode: "yolo",
    ...(model == null ? {} : { model }),
    emit: (event: DesktopEvent) => events.push(event),
  } as ConstructorParameters<typeof BotSession>[0]);

  return { session, events };
};

const readyModel = (events: DesktopEvent[]): string | undefined =>
  events.find(
    (event): event is Extract<DesktopEvent, { type: "ready" }> =>
      event.type === "ready"
  )?.model;

beforeAll(async () => {
  provider = await FakeProvider.start();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-botchat-home-"));
  botDir = path.join(home, "bots", "bot-1");
  fs.mkdirSync(path.join(home, "agent"), { recursive: true });
  fs.mkdirSync(botDir, { recursive: true });
  fs.writeFileSync(
    path.join(home, "agent", "settings.json"),
    JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }),
    "utf8"
  );
  fs.writeFileSync(path.join(home, "config.json"), openLlmConfig(), "utf8");
  process.env.ABACUSAI_BOT_HOME = home;
  process.env.ABACUSAI_BOT_BOT_DIR = botDir;
}, 60_000);

afterAll(async () => {
  await provider?.close();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.ABACUSAI_BOT_HOME;
  delete process.env.ABACUSAI_BOT_BOT_DIR;
});

describe("a bot on the router", () => {
  it("reports the router's id, not the model it resolved to", async () => {
    const { session, events } = botSession();

    await session.start();

    expect(readyModel(events)).toBe("openllm/auto");
  });

  it("keeps reporting it when the model is set to the router again", async () => {
    const { session, events } = botSession();
    await session.start();

    await session.setModel("openllm/auto");

    const changed = events
      .filter(
        (event): event is Extract<DesktopEvent, { type: "event" }> =>
          event.type === "event"
      )
      .map((event) => event.event)
      .filter((event) => event.type === "model_changed");

    expect(changed.at(-1)).toMatchObject({ model: "openllm/auto" });
  });
});

describe("a bot on a concrete model", () => {
  it("reports that model, because that is what was chosen", async () => {
    // Picking a model is leaving the router, not steering it — the picker
    // must follow the user here, not hold onto the router entry.
    const { session, events } = botSession();
    await session.start();

    await session.setModel("ollama/small");

    const changed = events
      .filter(
        (event): event is Extract<DesktopEvent, { type: "event" }> =>
          event.type === "event"
      )
      .map((event) => event.event)
      .filter((event) => event.type === "model_changed");

    expect(changed.at(-1)).toMatchObject({ model: "ollama/small" });
  });

  it("starts on it when the chat was pinned to one", async () => {
    const { session, events } = botSession("ollama/small");

    await session.start();

    expect(readyModel(events)).toBe("ollama/small");
  });
});

/**
 * A switch that fails must not move the picker.
 *
 * The router flag was set from the requested reference before the model had
 * resolved, so a switch that then failed left the chat on its old model while
 * `currentModelReference` claimed the router — the picker reported one model
 * and the turns ran on another. It is the same ordering the session loop uses.
 */
describe("a switch that cannot be made", () => {
  it("leaves the reported model where it was", async () => {
    const { session, events } = botSession("ollama/small");
    await session.start();
    expect(readyModel(events)).toBe("ollama/small");

    await session.setModel("nope/not-a-model");

    const changed = events
      .filter(
        (event): event is Extract<DesktopEvent, { type: "event" }> =>
          event.type === "event"
      )
      .map((event) => event.event);

    // It refuses, and says so — rather than reporting a model change that did
    // not happen.
    expect(changed.filter((event) => event.type === "model_changed")).toEqual(
      []
    );
    expect(
      changed.filter(
        (event) =>
          event.type === "error" && event.error?.code === "model_unavailable"
      )
    ).not.toEqual([]);
  });

  it("does not leave the router claimed after a failed switch to it", async () => {
    const { session, events } = botSession("ollama/small");
    await session.start();

    // Fails, then a successful switch to a concrete model: if the flag had
    // been left set by the failure, this would report the router instead.
    await session.setModel("nope/not-a-model");
    await session.setModel("ollama/big");

    const changed = events
      .filter(
        (event): event is Extract<DesktopEvent, { type: "event" }> =>
          event.type === "event"
      )
      .map((event) => event.event)
      .filter((event) => event.type === "model_changed");

    expect(changed.at(-1)).toMatchObject({ model: "ollama/big" });
  });
});
