/**
 * Every place the agent builds a resource loader keeps extensions from disk
 * out for a hosted account without local tools: the chat session, a
 * sub-agent and a bot's forever engine, each started for real against the
 * fake provider. An extension that runs leaves a marker file.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FakeProvider,
  fakeProviderConfig,
} from "@abacus-ai/test-support/fake-provider";
import {
  ModelRegistry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { BotSession } from "./bot/bot-session.js";
import { runDelegatedTask } from "./delegation.js";
import { HOSTED_LOCAL_TOOLS_ENV } from "./hosted-local-tools.js";
import { createModelRuntime } from "./providers.js";
import { AbacusBotSession } from "./session.js";

let provider: FakeProvider;
let home: string;
let agentDir: string;
let count = 0;

beforeAll(async () => {
  provider = await FakeProvider.start();
  provider.script(() => ({ say: "ok" }));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-local-tools-int-"));
  agentDir = path.join(home, "agent");
  fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
  fs.mkdirSync(path.join(home, "bots", "bot-1"), { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } })
  );
  fs.writeFileSync(
    path.join(home, "config.json"),
    fakeProviderConfig(provider),
    "utf8"
  );
  process.env.ABACUSAI_BOT_HOME = home;
  process.env.ABACUSAI_BOT_BOT_DIR = path.join(home, "bots", "bot-1");
  process.env.ABACUSAI_BOT_PHONE_DIR = path.join(home, "phone");
  process.env.PI_OFFLINE = "1";
}, 60_000);

afterAll(async () => {
  await provider?.close();
  fs.rmSync(home, { recursive: true, force: true });
  for (const name of [
    "ABACUSAI_BOT_HOME",
    "ABACUSAI_BOT_BOT_DIR",
    "ABACUSAI_BOT_PHONE_DIR",
    "PI_OFFLINE",
  ])
    delete process.env[name];
});

afterEach(() => {
  delete process.env[HOSTED_LOCAL_TOOLS_ENV];
  for (const file of fs.readdirSync(path.join(agentDir, "extensions")))
    fs.rmSync(path.join(agentDir, "extensions", file));
});

/** A fresh extension (a new path, so pi's module cache can't hide it) and its marker. */
const seedExtension = (): string => {
  count += 1;
  const marker = path.join(home, `extension-ran-${count}`);
  fs.writeFileSync(
    path.join(agentDir, "extensions", `marker-${count}.ts`),
    `import * as fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "x");\nexport default function () {}\n`
  );
  return marker;
};

const workspace = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), "hosted-local-tools-cwd-"));

const ENTRY_POINTS: Record<string, () => Promise<void>> = {
  "the chat session": async () => {
    const session = new AbacusBotSession({
      cwd: workspace(),
      mode: "yolo",
      emit: () => {},
    });
    try {
      await session.start();
    } finally {
      session.dispose();
    }
  },
  "a sub-agent": async () => {
    const cwd = workspace();
    const modelRuntime = await createModelRuntime(agentDir);
    const registry = new ModelRegistry(modelRuntime);
    registry.registerProvider("fake", {
      name: "fake",
      baseUrl: provider.baseUrl,
      apiKey: "test-key",
      api: "openai-completions" as const,
      models: [
        {
          id: "fake-1",
          name: "fake-1",
          reasoning: false,
          input: ["text" as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 131072,
          maxTokens: 8192,
        },
      ],
    });
    await runDelegatedTask(
      {
        cwd,
        agentDir,
        modelRuntime,
        settingsManager: SettingsManager.create(cwd, agentDir),
        skillPaths: [],
        model: registry
          .getAvailable()
          .find((model) => model.provider === "fake"),
      },
      "say ok",
      () => undefined
    );
  },
  "a bot's forever engine": async () => {
    const bot = new BotSession({
      cwd: workspace(),
      mode: "yolo",
      emit: () => {},
    });
    try {
      await bot.start();
    } finally {
      bot.dispose();
    }
  },
};

describe.each(Object.keys(ENTRY_POINTS))("%s", (entry) => {
  it("loads no extension from disk for a hosted account without local tools", async () => {
    process.env[HOSTED_LOCAL_TOOLS_ENV] = "off";
    const marker = seedExtension();

    await ENTRY_POINTS[entry]!();

    expect(fs.existsSync(marker)).toBe(false);
  }, 60_000);

  it("loads it for a paid hosted account", async () => {
    process.env[HOSTED_LOCAL_TOOLS_ENV] = "on";
    const marker = seedExtension();

    await ENTRY_POINTS[entry]!();

    expect(fs.existsSync(marker)).toBe(true);
  }, 60_000);
});
