/**
 * `~/.abacusai-bot/config.json`, as the app reads and writes it.
 *
 * This file is hand-editable, shared with the agent subprocess, and written by
 * several things at once — so the two properties that matter most are that a
 * write merges rather than replaces (a blind overwrite eats someone's local
 * provider definition), and that a reader never sees a half-written file. It
 * also holds API keys, which is why the mode and the "environment wins" rule
 * are pinned here too.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

let home: string;
/** Env vars a case set, restored afterwards so one test cannot leak into another. */
let restoreEnv: [string, string | undefined][];

const load = async (): Promise<typeof import("./settings")> =>
  import("./settings");

const configPath = (): string => path.join(home, "config.json");

const writeConfig = (contents: unknown): void => {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    configPath(),
    typeof contents === "string" ? contents : JSON.stringify(contents)
  );
};

const storedConfig = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(configPath(), "utf8")) as Record<string, unknown>;

const setEnv = (name: string, value: string | undefined): void => {
  restoreEnv.push([name, process.env[name]]);
  if (value == null) delete process.env[name];
  else process.env[name] = value;
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "settings-"));
  restoreEnv = [];
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  for (const [name, value] of restoreEnv) {
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe("reading a config file that is not what it should be", () => {
  it.each([
    ["truncated JSON", '{"apiKeys": {'],
    ["not JSON at all", "# a comment someone left"],
    ["an empty file", ""],
  ])("reads empty settings rather than throw on %s", async (_label, body) => {
    writeConfig(body);
    const { readSettings } = await load();

    expect(readSettings()).toEqual({});
  });

  it("reads empty settings for a JSON null", async () => {
    writeConfig("null");
    const { readSettings } = await load();

    expect(readSettings()).toEqual({});
  });

  it("reads empty settings when nothing has ever been written", async () => {
    const { readSettings } = await load();

    expect(readSettings()).toEqual({});
  });

  it("still answers every question a corrupt file cannot", async () => {
    // The whole point of the tolerance: a broken file degrades to defaults
    // instead of taking the app down on launch.
    writeConfig("{ broken");
    const settings = await load();

    expect(settings.readExecBackend()).toBeUndefined();
    expect(settings.readDefaultAgentMode()).toBe("YOLO");
    expect(settings.readDockerImage()).toBeUndefined();
    expect(settings.readToolsetPreferences()).toEqual({});
    expect(settings.credentialEnv()).toEqual({});
  });
});

describe("writing without losing what was already there", () => {
  it("keeps keys the UI knows nothing about", async () => {
    // config.json is hand-editable and holds custom provider definitions; a
    // blind overwrite would eat someone's local llama.cpp config the first time
    // they picked a model.
    writeConfig({
      customProviders: { llamacpp: { baseUrl: "http://localhost:8080" } },
      defaultModel: "old-model",
    });
    const { setDefaultModel } = await load();

    setDefaultModel("new-model");

    expect(storedConfig()).toEqual({
      customProviders: { llamacpp: { baseUrl: "http://localhost:8080" } },
      defaultModel: "new-model",
    });
  });

  it("leaves no temp file behind for the next reader to trip over", async () => {
    const { setDefaultModel } = await load();

    setDefaultModel("a-model");

    expect(fs.readdirSync(home)).toEqual(["config.json"]);
  });

  // Skipped on Windows: it has no POSIX mode bits for chmod to set.
  it.skipIf(process.platform === "win32")(
    "keeps the file readable only by its owner",
    async () => {
      const { saveApiKey } = await load();

      saveApiKey("openai", "sk-test");

      expect(fs.statSync(configPath()).mode & 0o777).toBe(0o600);
    }
  );

  // Skipped on Windows: it has no POSIX mode bits for chmod to set.
  it.skipIf(process.platform === "win32")(
    "tightens the mode of a world-readable file from an older build",
    async () => {
      writeConfig({ defaultModel: "old" });
      fs.chmodSync(configPath(), 0o644);
      const { setDefaultModel } = await load();

      setDefaultModel("new");

      expect(fs.statSync(configPath()).mode & 0o777).toBe(0o600);
    }
  );

  it("creates the directory when the app has never written there", async () => {
    fs.rmSync(home, { recursive: true, force: true });
    const { setDefaultModel } = await load();

    setDefaultModel("a-model");

    expect(storedConfig().defaultModel).toBe("a-model");
  });

  it("returns the settings it just wrote", async () => {
    const { setDefaultModel } = await load();

    expect(setDefaultModel("a-model")).toMatchObject({
      defaultModel: "a-model",
    });
  });
});

describe("storing a provider's API key", () => {
  it("stores it under the provider's environment variable name", async () => {
    // The same name the agent reads from its environment, so a key typed in the
    // UI and one exported in a shell profile are the same thing.
    const { saveApiKey } = await load();

    saveApiKey("anthropic", "sk-ant-123");

    expect(storedConfig().apiKeys).toEqual({ ANTHROPIC_API_KEY: "sk-ant-123" });
  });

  it("trims a key that was pasted with whitespace around it", async () => {
    const { saveApiKey } = await load();

    saveApiKey("openai", "  sk-openai-123\n");

    expect(storedConfig().apiKeys).toEqual({ OPENAI_API_KEY: "sk-openai-123" });
  });

  it.each([
    ["an empty string", ""],
    ["only whitespace", "   \n "],
  ])("removes the key when given %s", async (_label, value) => {
    writeConfig({ apiKeys: { OPENAI_API_KEY: "sk-old" } });
    const { saveApiKey } = await load();

    saveApiKey("openai", value);

    expect(storedConfig().apiKeys).toEqual({});
  });

  it("leaves other providers' keys alone", async () => {
    writeConfig({ apiKeys: { ANTHROPIC_API_KEY: "sk-ant" } });
    const { saveApiKey } = await load();

    saveApiKey("openai", "sk-openai");

    expect(storedConfig().apiKeys).toEqual({
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-openai",
    });
  });

  it("writes nothing for a provider it has no variable name for", async () => {
    writeConfig({ apiKeys: { OPENAI_API_KEY: "sk-old" } });
    const { saveApiKey } = await load();

    expect(saveApiKey("not-a-provider", "sk-whatever")).toEqual({
      apiKeys: { OPENAI_API_KEY: "sk-old" },
    });
    expect(storedConfig().apiKeys).toEqual({ OPENAI_API_KEY: "sk-old" });
  });
});

describe("the execution backend", () => {
  it.each([
    ["local"],
    ["docker"],
    ["singularity"],
    ["modal"],
    ["daytona"],
    ["ssh"],
  ])("reads back %s", async (backend) => {
    const { setExecBackend, readExecBackend } = await load();

    setExecBackend(backend as never);

    expect(readExecBackend()).toBe(backend);
  });

  it.each([
    ["a backend that does not exist", "podman"],
    ["the wrong type", 7],
    ["nothing stored", undefined],
  ])(
    "reads nothing for %s, leaving the choice to the resolver",
    async (_label, stored) => {
      writeConfig(stored == null ? {} : { execBackend: stored });
      const { readExecBackend } = await load();

      expect(readExecBackend()).toBeUndefined();
    }
  );
});

describe("the terminal panel's shell", () => {
  it("is the platform default until one is picked", async () => {
    const { readTerminalShell } = await load();

    expect(readTerminalShell()).toBe("system");
  });

  it.each([["cmd"], ["powershell"], ["pwsh"], ["busybox"]])(
    "reads back %s",
    async (shell) => {
      const { setTerminalShell, readTerminalShell } = await load();

      setTerminalShell(shell as never);

      expect(readTerminalShell()).toBe(shell);
    }
  );

  it.each([
    ["a shell nobody has heard of", "nushell"],
    // The shells the panel used to offer off Windows, which it no longer does.
    ["one of the retired POSIX ids", "zsh"],
    ["the wrong type", 7],
  ])("falls back to the default for %s", async (_label, stored) => {
    writeConfig({ terminalShell: stored });
    const { readTerminalShell } = await load();

    expect(readTerminalShell()).toBe("system");
  });
});

describe("the default permission mode", () => {
  it("is Full access when nothing has been stored", async () => {
    const { readDefaultAgentMode } = await load();

    expect(readDefaultAgentMode()).toBe("YOLO");
  });

  it.each([
    ["a mode that is not a default", "PLAN"],
    ["a lower-case spelling", "auto"],
    ["a number", 0],
    ["null", null],
  ])(
    "reads %s as Full access rather than guessing at Auto",
    async (_label, stored) => {
      writeConfig({ defaultMode: stored });
      const { readDefaultAgentMode } = await load();

      expect(readDefaultAgentMode()).toBe("YOLO");
    }
  );

  it("records a switch to Auto, and back", async () => {
    const { setDefaultAgentMode, readDefaultAgentMode } = await load();

    setDefaultAgentMode("AUTO" as never);
    expect(readDefaultAgentMode()).toBe("AUTO");

    setDefaultAgentMode("YOLO" as never);
    expect(readDefaultAgentMode()).toBe("YOLO");
  });
});

describe("the docker image", () => {
  it("is absent when nothing has been stored", async () => {
    const { readDockerImage } = await load();

    expect(readDockerImage()).toBeUndefined();
  });

  it.each([
    ["an empty string", "", undefined],
    ["only whitespace", "   ", undefined],
    ["a padded image name", "  node:22  ", "node:22"],
    ["an image name", "ghcr.io/acme/dev:2", "ghcr.io/acme/dev:2"],
  ])("reads %s as %s", async (_label, stored, expected) => {
    writeConfig({ execDockerImage: stored });
    const { readDockerImage } = await load();

    expect(readDockerImage()).toBe(expected);
  });
});

describe("toolsets, which are a statement about this machine", () => {
  it("has no preferences until the user touches a toggle", async () => {
    // The registry stays in charge of defaults for everything untouched.
    const { readToolsetPreferences } = await load();

    expect(readToolsetPreferences()).toEqual({});
  });

  it("records only the groups that were switched", async () => {
    const { setToolsetEnabled, readToolsetPreferences } = await load();

    setToolsetEnabled("documents", false);
    setToolsetEnabled("web", true);

    expect(readToolsetPreferences()).toEqual({
      documents: false,
      web: true,
    });
  });

  it("replaces an earlier answer for the same group", async () => {
    const { setToolsetEnabled, readToolsetPreferences } = await load();

    setToolsetEnabled("documents", false);
    setToolsetEnabled("documents", true);

    expect(readToolsetPreferences()).toEqual({ documents: true });
  });
});

describe("credentials for the agent's environment", () => {
  it("supplies a stored key the environment does not already have", async () => {
    setEnv("OPENAI_API_KEY", undefined);
    writeConfig({ apiKeys: { OPENAI_API_KEY: "sk-stored" } });
    const { credentialEnv } = await load();

    expect(credentialEnv()).toEqual({ OPENAI_API_KEY: "sk-stored" });
  });

  it("stands aside for a key the environment already provides", async () => {
    // The environment always wins: a key from a shell profile or a secrets
    // manager takes precedence over anything stored here.
    setEnv("OPENAI_API_KEY", "sk-from-env");
    writeConfig({ apiKeys: { OPENAI_API_KEY: "sk-stored" } });
    const { credentialEnv } = await load();

    expect(credentialEnv()).toEqual({});
  });

  it("treats an empty environment variable as absent", async () => {
    setEnv("OPENAI_API_KEY", "");
    writeConfig({ apiKeys: { OPENAI_API_KEY: "sk-stored" } });
    const { credentialEnv } = await load();

    expect(credentialEnv()).toEqual({ OPENAI_API_KEY: "sk-stored" });
  });

  it("does not supply a stored key that is empty", async () => {
    setEnv("OPENAI_API_KEY", undefined);
    writeConfig({ apiKeys: { OPENAI_API_KEY: "" } });
    const { credentialEnv } = await load();

    expect(credentialEnv()).toEqual({});
  });
});

describe("one credential, for a tool running in this process", () => {
  it("prefers the environment", async () => {
    setEnv("GEMINI_API_KEY", "sk-from-env");
    writeConfig({ apiKeys: { GEMINI_API_KEY: "sk-stored" } });
    const { credentialFor } = await load();

    expect(credentialFor("GEMINI_API_KEY")).toBe("sk-from-env");
  });

  it("falls back to the stored key", async () => {
    // In a packaged app launched from Finder the environment is empty, and an
    // env-only read concludes "not configured" about a key sitting in Settings.
    setEnv("GEMINI_API_KEY", undefined);
    writeConfig({ apiKeys: { GEMINI_API_KEY: "sk-stored" } });
    const { credentialFor } = await load();

    expect(credentialFor("GEMINI_API_KEY")).toBe("sk-stored");
  });

  it("trims both sources", async () => {
    setEnv("GEMINI_API_KEY", "  sk-from-env  ");
    const { credentialFor } = await load();
    expect(credentialFor("GEMINI_API_KEY")).toBe("sk-from-env");

    setEnv("GEMINI_API_KEY", "   ");
    writeConfig({ apiKeys: { GEMINI_API_KEY: "  sk-stored  " } });
    expect(credentialFor("GEMINI_API_KEY")).toBe("sk-stored");
  });

  it("is empty when neither source has one", async () => {
    setEnv("GEMINI_API_KEY", undefined);
    const { credentialFor } = await load();

    expect(credentialFor("GEMINI_API_KEY")).toBe("");
  });
});

describe("whether a provider can run at all", () => {
  it.each([
    ["the environment has it", "sk-from-env", {}, true],
    [
      "only the file has it",
      undefined,
      { DEEPSEEK_API_KEY: "sk-stored" },
      true,
    ],
    ["neither has it", undefined, {}, false],
    ["the stored key is empty", undefined, { DEEPSEEK_API_KEY: "" }, false],
  ])("is %s", async (_label, envValue, apiKeys, expected) => {
    setEnv("DEEPSEEK_API_KEY", envValue);
    writeConfig({ apiKeys });
    const { hasCredential } = await load();

    expect(hasCredential("DEEPSEEK_API_KEY")).toBe(expected);
  });

  it("is false for a provider with no environment variable to check", async () => {
    const { hasCredential } = await load();

    expect(hasCredential(undefined)).toBe(false);
  });
});

describe("whether pi holds an OAuth credential", () => {
  const writeAgentAuth = (contents: unknown): void => {
    fs.mkdirSync(path.join(home, "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "agent", "auth.json"),
      typeof contents === "string" ? contents : JSON.stringify(contents)
    );
  };

  it("is false when the agent has never signed in to anything", async () => {
    const { hasOAuthCredential } = await load();

    expect(hasOAuthCredential("openai-codex")).toBe(false);
  });

  it("is true for a provider the agent holds a credential for", async () => {
    writeAgentAuth({ "openai-codex": { refresh: "token" } });
    const { hasOAuthCredential } = await load();

    expect(hasOAuthCredential("openai-codex")).toBe(true);
  });

  it("is false for a provider that is not in the file", async () => {
    // Treating "no env var" as "always available" made Codex look configured on
    // a machine with no credentials at all — and it then got auto-selected.
    writeAgentAuth({ anthropic: { refresh: "token" } });
    const { hasOAuthCredential } = await load();

    expect(hasOAuthCredential("openai-codex")).toBe(false);
  });

  it("is false for a provider stored as null", async () => {
    writeAgentAuth({ "openai-codex": null });
    const { hasOAuthCredential } = await load();

    expect(hasOAuthCredential("openai-codex")).toBe(false);
  });

  it("is false rather than throwing on a corrupt auth file", async () => {
    writeAgentAuth("{ truncated");
    const { hasOAuthCredential } = await load();

    expect(hasOAuthCredential("openai-codex")).toBe(false);
  });
});

describe("which providers have a key stored here", () => {
  it("names the providers and never the keys", async () => {
    writeConfig({
      apiKeys: { GROQ_API_KEY: "gsk-stored", MISTRAL_API_KEY: "  " },
    });
    const { storedKeyProviders } = await load();

    expect(storedKeyProviders()).toEqual(["groq"]);
  });

  it("ignores a key that only exists in the environment", async () => {
    // Nothing in this app can take back a variable the shell exported, so the
    // connect page must not offer a Remove button for one.
    writeConfig({ apiKeys: {} });
    setEnv("XAI_API_KEY", "xai-from-the-shell");
    const { storedKeyProviders } = await load();

    expect(storedKeyProviders()).toEqual([]);
  });

  it("ignores a variable that belongs to no provider", async () => {
    writeConfig({ apiKeys: { SOMETHING_ELSE: "value" } });
    const { storedKeyProviders } = await load();

    expect(storedKeyProviders()).toEqual([]);
  });
});

describe("whether X searches are routed to xAI", () => {
  it("is off with a key stored but the switch untouched", async () => {
    // The whole point: an xAI key pasted to run Grok is a model key, and a
    // model key must not silently decide where a search query is sent.
    writeConfig({ apiKeys: { XAI_API_KEY: "xai-pasted-for-grok" } });
    setEnv("XAI_API_KEY", undefined);
    const { readXaiSearchEnabled } = await load();

    expect(readXaiSearchEnabled()).toBe(false);
  });

  it("is on once the switch is on", async () => {
    writeConfig({ apiKeys: { XAI_API_KEY: "xai-key" }, xaiSearch: true });
    setEnv("XAI_API_KEY", undefined);
    const { readXaiSearchEnabled } = await load();

    expect(readXaiSearchEnabled()).toBe(true);
  });

  it("is on for a key exported in the shell, switch or no switch", async () => {
    // What docs/capabilities.md has always promised for this variable.
    writeConfig({});
    setEnv("XAI_API_KEY", "xai-from-the-shell");
    const { readXaiSearchEnabled } = await load();

    expect(readXaiSearchEnabled()).toBe(true);
  });

  it("reports the stored preference to the switch, not the resolved state", async () => {
    // Otherwise an environment variable would show as a switch nobody can move.
    writeConfig({});
    setEnv("XAI_API_KEY", "xai-from-the-shell");
    const { readXaiSearchPreference } = await load();

    expect(readXaiSearchPreference()).toBe(false);
  });

  it("stores the switch without disturbing the rest of the file", async () => {
    writeConfig({ defaultModel: "groq/llama", apiKeys: { GROQ_API_KEY: "k" } });
    const { setXaiSearchEnabled } = await load();

    setXaiSearchEnabled(true);

    expect(storedConfig()).toMatchObject({
      defaultModel: "groq/llama",
      apiKeys: { GROQ_API_KEY: "k" },
      xaiSearch: true,
    });
  });
});
