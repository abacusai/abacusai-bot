/**
 * A bot chat's `bash` is the session's own tool: one `bash` in the list, and a
 * command's output comes back to the model. pi's built-in, which this replaces,
 * resolved its shell on its own and found none on a Windows machine without
 * Git Bash.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FakeProvider,
  fakeProviderConfig,
} from "@abacus-ai/test-support/fake-provider";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { DesktopEvent } from "../protocol.js";
import { BotSession } from "./bot-session.js";

let provider: FakeProvider;
let home: string;
let bot: BotSession | null = null;

beforeAll(async () => {
  provider = await FakeProvider.start();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-botbash-home-"));
  const botDir = path.join(home, "bots", "bot-1");
  fs.mkdirSync(path.join(home, "agent"), { recursive: true });
  fs.mkdirSync(botDir, { recursive: true });
  fs.writeFileSync(
    path.join(home, "agent", "settings.json"),
    JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(home, "config.json"),
    fakeProviderConfig(provider),
    "utf8"
  );
  process.env.ABACUSAI_BOT_HOME = home;
  process.env.ABACUSAI_BOT_BOT_DIR = botDir;
  process.env.PI_OFFLINE = "1";
}, 60_000);

afterAll(async () => {
  await provider?.close();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.ABACUSAI_BOT_HOME;
  delete process.env.ABACUSAI_BOT_BOT_DIR;
});

afterEach(() => {
  bot?.dispose();
  bot = null;
  provider.calls.length = 0;
});

describe("a bot's shell", () => {
  it("is one bash tool, and a command's output reaches the model", async () => {
    provider.script((_call, index) =>
      index === 0
        ? {
            call: { name: "bash", args: { command: "echo bot-shell-ok" } },
          }
        : { say: "done" }
    );
    bot = new BotSession({
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-botbash-")),
      mode: "yolo",
      emit: (_event: DesktopEvent) => {},
    });
    await bot.start();
    await bot.send("run it");

    const offered = provider.calls[0]?.tools ?? [];
    expect(offered.filter((name) => name === "bash")).toHaveLength(1);
    expect(JSON.stringify(provider.calls[1]?.messages)).toContain(
      "bot-shell-ok"
    );
  }, 60_000);
});
