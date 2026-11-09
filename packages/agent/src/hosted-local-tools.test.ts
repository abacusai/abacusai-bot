/**
 * An agent the hosted computer starts never reads the raw server file, and with
 * local tools "off" nothing from disk runs: no extension, no settings package,
 * no npm command. Each case is checked by what actually runs: a local command,
 * extension or npm command that leaves a marker file.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ModelRegistry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyStoredApiKeys } from "./config.js";
import { HOSTED_LOCAL_TOOLS_ENV } from "./hosted-local-tools.js";
import { connectMcpServers } from "./mcp/index.js";
import { createModelRuntime, registerCustomProviders } from "./providers.js";
import { createResourceLoader } from "./resource-loader.js";

let home: string;
const saved = {
  home: process.env.ABACUSAI_BOT_HOME,
  config: process.env.ABACUSAI_BOT_MCP_CONFIG,
  flag: process.env[HOSTED_LOCAL_TOOLS_ENV],
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-local-tools-"));
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

const writeMarker = (marker: string): string =>
  `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`;

describe("an agent started without a server list", () => {
  const marker = () => path.join(home, "mcp-ran");
  const writeLocalServer = () =>
    fs.writeFileSync(
      path.join(home, "mcp-code.json"),
      JSON.stringify({
        mcpServers: {
          local: {
            command: process.execPath,
            args: ["-e", writeMarker(marker())],
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
      expect(fs.existsSync(marker())).toBe(false);
    }
  );

  it("still falls back to the app's file outside the hosted computer", async () => {
    writeLocalServer();

    await connectMcpServers(undefined);

    expect(fs.existsSync(marker())).toBe(true);
  });
});

describe("the resource loader", () => {
  /** An extension and a settings package whose npm command each leave a marker. */
  const seed = () => {
    const agentDir = path.join(home, "agent");
    const cwd = path.join(home, "work");
    const extensionMarker = path.join(home, "extension-ran");
    const npmMarker = path.join(home, "npm-ran");
    fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "extensions", "marker.ts"),
      `import * as fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(extensionMarker)}, "x");\nexport default function () {}\n`
    );
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        packages: ["npm:an-example-package"],
        npmCommand: [process.execPath, "-e", writeMarker(npmMarker)],
      })
    );
    return { agentDir, cwd, extensionMarker, npmMarker };
  };

  const load = async (flag: string | undefined) => {
    const seeded = seed();
    const env = flag == null ? {} : { [HOSTED_LOCAL_TOOLS_ENV]: flag };
    const loader = createResourceLoader(
      {
        cwd: seeded.cwd,
        agentDir: seeded.agentDir,
        settingsManager: SettingsManager.create(seeded.cwd, seeded.agentDir),
      },
      env
    );
    await loader.reload().catch(() => undefined);
    return {
      ...seeded,
      extensions: loader
        .getExtensions()
        .extensions.filter((e) => !e.path.startsWith("<inline")).length,
    };
  };

  it("runs nothing from disk for a hosted account without local tools", async () => {
    const run = await load("off");

    expect(run.extensions).toBe(0);
    expect(fs.existsSync(run.extensionMarker)).toBe(false);
    expect(fs.existsSync(run.npmMarker)).toBe(false);
  });

  it.each([
    ["a paid hosted account", "on"],
    ["the desktop app", undefined],
  ])("still loads both for %s", async (_case, flag) => {
    const run = await load(flag);

    expect(run.extensions).toBe(1);
    expect(fs.existsSync(run.extensionMarker)).toBe(true);
    expect(fs.existsSync(run.npmMarker)).toBe(true);
  });
});

describe("stored keys", () => {
  it("only the app's own key names reach the environment", () => {
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        apiKeys: {
          OPENAI_API_KEY: ["sk", "stored"].join("-"),
          LD_PRELOAD: "/tmp/x.so",
          NODE_OPTIONS: "--require /tmp/x.js",
          PI_OFFLINE: "0",
          ABACUSAI_BOT_MCP_CONFIG: "/tmp/list.json",
        },
      })
    );
    const env: NodeJS.ProcessEnv = {};

    expect(applyStoredApiKeys(env)).toEqual(["OPENAI_API_KEY"]);
    expect(Object.keys(env)).toEqual(["OPENAI_API_KEY"]);
  });
});

describe("every resource loader", () => {
  it("is built through createResourceLoader, so the hosted policy applies", () => {
    const sources = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) return sources(file);
        return entry.name.endsWith(".ts") && !entry.name.includes(".test.")
          ? [file]
          : [];
      });
    const direct = sources(import.meta.dirname)
      .filter((file) => !file.endsWith("resource-loader.ts"))
      .filter((file) =>
        fs.readFileSync(file, "utf8").includes("new DefaultResourceLoader(")
      );

    expect(direct).toEqual([]);
  });
});

describe("config values pi would run as a command", () => {
  let n = 0;
  /** A `!command` that leaves a marker, unique per use (pi caches results). */
  const command = (): { value: string; marker: string } => {
    n += 1;
    const marker = path.join(home, `config-ran-${n}`);
    return { value: `!touch ${JSON.stringify(marker)}`, marker };
  };

  /** Build the runtime and registry and ask what is available, as a session does. */
  const exercise = async (
    agentDir: string,
    custom: { apiKey?: string; headers?: Record<string, string> } = {}
  ): Promise<void> => {
    const runtime = await createModelRuntime(agentDir);
    const registry = new ModelRegistry(runtime);
    registerCustomProviders(registry, {
      customProviders:
        Object.keys(custom).length === 0
          ? []
          : [
              {
                id: "mine",
                baseUrl: "http://127.0.0.1:9/v1",
                ...custom,
                models: [{ id: "m1" }],
              },
            ],
    });
    registry.getAvailable();
    for (const provider of ["openai", "mine"])
      registry.getProviderAuthStatus(provider);
    // And resolve auth, as a request does.
    for (const model of registry
      .getAll()
      .filter((m) => ["openai", "mine"].includes(m.provider))) {
      registry.hasConfiguredAuth(model);
      await registry.getApiKeyAndHeaders(model).catch(() => undefined);
    }
    for (const provider of ["openai", "mine"])
      await registry.getApiKeyForProvider(provider).catch(() => undefined);
  };

  const agentDirWith = (files: Record<string, unknown>): string => {
    const agentDir = path.join(home, `agent-${n}-${Math.random()}`);
    fs.mkdirSync(agentDir, { recursive: true });
    for (const [name, content] of Object.entries(files))
      fs.writeFileSync(path.join(agentDir, name), JSON.stringify(content));
    return agentDir;
  };

  const cases = {
    "auth.json": () => {
      const run = command();
      return {
        marker: run.marker,
        go: () =>
          exercise(
            agentDirWith({
              "auth.json": { openai: { type: "api_key", key: run.value } },
            })
          ),
      };
    },
    "models.json": () => {
      const run = command();
      return {
        marker: run.marker,
        go: () =>
          exercise(
            agentDirWith({
              "models.json": {
                providers: {
                  openai: { apiKey: run.value, headers: { X: run.value } },
                },
                openai: {
                  models: [{ id: "x", headers: { X: run.value } }],
                },
              },
            })
          ),
      };
    },
    "a custom provider's key": () => {
      const run = command();
      return {
        marker: run.marker,
        go: () => exercise(agentDirWith({}), { apiKey: run.value }),
      };
    },
    "a custom provider's header": () => {
      const run = command();
      return {
        marker: run.marker,
        go: () =>
          exercise(agentDirWith({}), {
            apiKey: "plain",
            headers: { "X-Key": run.value },
          }),
      };
    },
  };

  it.each(Object.keys(cases))(
    "in %s never runs for a hosted account without local tools",
    async (name) => {
      process.env[HOSTED_LOCAL_TOOLS_ENV] = "off";
      const { marker, go } = cases[name as keyof typeof cases]();

      await go().catch(() => undefined);

      expect(fs.existsSync(marker)).toBe(false);
    }
  );

  it.each(["auth.json", "a custom provider's key"])(
    "in %s still runs as before for a paid hosted account and on desktop",
    async (name) => {
      for (const flag of ["on", undefined]) {
        if (flag == null) delete process.env[HOSTED_LOCAL_TOOLS_ENV];
        else process.env[HOSTED_LOCAL_TOOLS_ENV] = flag;
        const { marker, go } = cases[name as keyof typeof cases]();

        await go().catch(() => undefined);

        expect(fs.existsSync(marker)).toBe(true);
      }
    }
  );
});
