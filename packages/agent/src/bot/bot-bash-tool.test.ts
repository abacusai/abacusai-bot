/**
 * A bot's `bash` runs through the session's operations — the bundled shell on
 * Windows, the sandbox elsewhere — not pi's built-in, which looks for Git Bash
 * on PATH and on a stock Windows machine finds nothing.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { currentMode } from "../current-mode.js";
import { AgentMode } from "../protocol.js";
import { botBashTool, BotSession } from "./bot-session.js";

describe("the bot's bash tool", () => {
  it("runs in the bot's own mode, so a YOLO bot is not confined as Normal", () => {
    // The sandbox reads the process-wide mode; only the coding session set
    // it, so a bot sandboxed under Normal's policy whatever mode it ran in.
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "abacusai-bot-botmode-")
    );
    const botDir = path.join(home, "bots", "bot-1");
    fs.mkdirSync(botDir, { recursive: true });
    process.env.ABACUSAI_BOT_HOME = home;
    process.env.ABACUSAI_BOT_BOT_DIR = botDir;
    try {
      new BotSession({
        cwd: home,
        mode: "yolo",
        emit: () => {},
      } as ConstructorParameters<typeof BotSession>[0]);

      expect(currentMode()).toBe(AgentMode.Yolo);
    } finally {
      delete process.env.ABACUSAI_BOT_HOME;
      delete process.env.ABACUSAI_BOT_BOT_DIR;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("is named bash, so it replaces pi's built-in", () => {
    expect(botBashTool("/tmp").name).toBe("bash");
  });

  it("runs commands through the operations it is given", async () => {
    const exec = vi.fn(
      async (
        _command: string,
        _cwd: string,
        options: { onData: (data: Buffer) => void }
      ) => {
        options.onData(Buffer.from("ok\n"));

        return { exitCode: 0 };
      }
    );
    const tool = botBashTool("/tmp", { exec } as never);

    const result = await tool.execute(
      "call-1",
      { command: "echo ok" },
      undefined,
      undefined,
      undefined as never
    );

    expect(exec).toHaveBeenCalledWith(
      "echo ok",
      "/tmp",
      expect.objectContaining({ onData: expect.any(Function) })
    );
    expect(JSON.stringify(result)).toContain("ok");
  });
});
