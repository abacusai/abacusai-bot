/**
 * Which environment the stdio transport reasons about.
 *
 * A server is spawned with `{ ...process.env, ...config.env }`, so that — not
 * this process's own environment — is what decides how the command resolves
 * and what cmd.exe would expand. Deciding against `process.env` let a variable
 * defined only in the server's config slip past both.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const spawned: Array<{
  file: string;
  args: string[];
  options: { env?: NodeJS.ProcessEnv };
}> = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();

  return {
    ...actual,
    spawn: (
      file: string,
      args: string[],
      options: { env?: NodeJS.ProcessEnv }
    ) => {
      spawned.push({ file, args, options });

      const child = Object.assign(new PassThrough(), {
        pid: 1234,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });

      return child;
    },
  };
});

const { McpClient } = await import("./client.js");

let bin: string;
const realPlatform = process.platform;

beforeAll(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), "stdio-env-"));
  fs.writeFileSync(path.join(bin, "npx.cmd"), "");
});

afterEach(() => {
  spawned.length = 0;
  Object.defineProperty(process, "platform", {
    value: realPlatform,
    configurable: true,
  });
});

/** Pretend this process is running on Windows for the current test. */
const onWindows = (): void => {
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
};

describe("the environment a stdio server is resolved against", () => {
  it("is the child's, so a PATH set only in the config still resolves", () => {
    onWindows();

    McpClient.stdioTransport("npx", ["server"], {
      PATH: bin,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    });

    // The .cmd shim was found, so the cmd.exe wrapper was chosen over a
    // direct spawn Node would have refused.
    expect(spawned[0]?.file).toBe("cmd.exe");
    expect(spawned[0]?.args[3]).toContain(path.join(bin, "npx.cmd"));
  });

  it("is the child's for %VAR% too, not this process's", () => {
    // The variable exists only in the server's own config env. Checking
    // process.env said "undefined, therefore safe", and cmd.exe then expanded
    // it anyway — the exact silent rewrite the check exists to stop.
    onWindows();

    McpClient.stdioTransport("npx", ["--root", "%SERVER_HOME%\\data"], {
      PATH: bin,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SERVER_HOME: "C:\\srv",
    });

    expect(spawned[0]?.args[3]).toContain("C:\\srv\\data");
    expect(spawned[0]?.args[3]).not.toContain("%SERVER_HOME%");
  });

  it("hands that same environment to the spawn", () => {
    McpClient.stdioTransport("some-server", [], { SERVER_HOME: "/srv" });

    expect(spawned[0]?.options.env?.SERVER_HOME).toBe("/srv");
    expect(spawned[0]?.options.env?.PATH).toBe(process.env.PATH);
  });
});
