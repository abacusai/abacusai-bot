/**
 * A bot's `bash` runs through the session's operations — the bundled shell on
 * Windows, the sandbox elsewhere — not pi's built-in, which looks for Git Bash
 * on PATH and on a stock Windows machine finds nothing.
 */
import { describe, expect, it, vi } from "vitest";

import { botBashTool } from "./bot-session.js";

describe("the bot's bash tool", () => {
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
      undefined as never,
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
