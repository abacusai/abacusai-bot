/**
 * An agent the hosted computer starts never reads the raw server file, and with
 * local tools "off" it loads no extension from disk. Both are checked by what
 * actually runs: a local command or extension that leaves a marker file.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  diskExtensionsAllowed,
  HOSTED_LOCAL_TOOLS_ENV,
} from "./hosted-local-tools.js";
import { connectMcpServers } from "./mcp/index.js";

let home: string;
let marker: string;
const saved = {
  home: process.env.ABACUSAI_BOT_HOME,
  config: process.env.ABACUSAI_BOT_MCP_CONFIG,
  flag: process.env[HOSTED_LOCAL_TOOLS_ENV],
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-local-tools-"));
  marker = path.join(home, "ran");
  process.env.ABACUSAI_BOT_HOME = home;
  delete process.env.ABACUSAI_BOT_MCP_CONFIG;
  delete process.env[HOSTED_LOCAL_TOOLS_ENV];
});
afterEach(() => {
  for (const [key, value] of [
    ["ABACUSAI_BOT_HOME", saved.home],
    ["ABACUSAI_BOT_MCP_CONFIG", saved.config],
    [HOSTED_LOCAL_TOOLS_ENV, saved.flag],
  ] as const)
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("an agent started without a server list", () => {
  const writeLocalServer = () =>
    fs.writeFileSync(
      path.join(home, "mcp-code.json"),
      JSON.stringify({
        mcpServers: {
          local: {
            command: process.execPath,
            args: [
              "-e",
              `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`,
            ],
          },
        },
      })
    );

  it.each(["on", "off"])(
    "starts no local command when the hosted computer started it (%s)",
    async (flag) => {
      writeLocalServer();
      process.env[HOSTED_LOCAL_TOOLS_ENV] = flag;

      const connected = await connectMcpServers(undefined);

      expect(connected.clients).toEqual([]);
      expect(fs.existsSync(marker)).toBe(false);
    }
  );

  it("still falls back to the app's file outside the hosted computer", async () => {
    writeLocalServer();

    await connectMcpServers(undefined);

    expect(fs.existsSync(marker)).toBe(true);
  });
});

describe("extensions from disk", () => {
  const loadWith = async (flag: string | undefined): Promise<number> => {
    const agentDir = path.join(home, "agent");
    const cwd = path.join(home, "work");
    fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
    fs.mkdirSync(cwd);
    fs.writeFileSync(
      path.join(agentDir, "extensions", "marker.ts"),
      `import * as fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "x");\nexport default function () {}\n`
    );
    const env = flag == null ? {} : { [HOSTED_LOCAL_TOOLS_ENV]: flag };
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      noExtensions: !diskExtensionsAllowed(env),
    });
    await loader.reload();
    return loader
      .getExtensions()
      .extensions.filter((extension) => !extension.path.startsWith("<inline"))
      .length;
  };

  it("are not loaded for a hosted account without local tools", async () => {
    expect(await loadWith("off")).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each([
    ["a paid hosted account", "on"],
    ["the desktop app", undefined],
  ])("still load for %s", async (_case, flag) => {
    expect(await loadWith(flag)).toBe(1);
    expect(fs.existsSync(marker)).toBe(true);
  });
});
