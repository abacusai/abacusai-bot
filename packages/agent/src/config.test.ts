/**
 * One home directory, one set of credentials.
 *
 * The desktop app writes provider keys to `apiKeys` in config.json and injects
 * them when it spawns the agent, so the app always worked. Nothing in this
 * package read that field, so the terminal client (same machine, same
 * `~/.abacusai-bot`, same file) behaved as though the user had no keys at
 * all: it either refused to start or silently fell back to whatever other
 * provider happened to be configured.
 *
 * These tests run against a temporary home via ABACUSAI_BOT_HOME and a
 * throwaway env object, so nothing here can read or write the developer's real
 * keys.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyStoredApiKeys } from "./config.js";

let home: string;
let previousHome: string | undefined;

const writeConfig = (config: unknown): void => {
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify(config),
    "utf8"
  );
};

beforeEach(() => {
  previousHome = process.env.ABACUSAI_BOT_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-config-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;

  fs.rmSync(home, { recursive: true, force: true });
});

describe("keys saved by the desktop app", () => {
  it("reach a front end that only reads the environment", () => {
    // The bug, in one line: this key was on disk and invisible.
    writeConfig({ apiKeys: { ABACUS_API_KEY: "from-the-app" } });

    const env: NodeJS.ProcessEnv = {};

    expect(applyStoredApiKeys(env)).toEqual(["ABACUS_API_KEY"]);
    expect(env.ABACUS_API_KEY).toBe("from-the-app");
  });

  it("carries every provider, not a known list of them", () => {
    writeConfig({
      apiKeys: {
        ABACUS_API_KEY: "a",
        OPENROUTER_API_KEY: "b",
        SOME_FUTURE_PROVIDER_KEY: "c",
      },
    });

    const env: NodeJS.ProcessEnv = {};

    expect(applyStoredApiKeys(env).sort()).toEqual([
      "ABACUS_API_KEY",
      "OPENROUTER_API_KEY",
      "SOME_FUTURE_PROVIDER_KEY",
    ]);
  });
});

describe("what the environment still decides", () => {
  it("never overwrites a key exported in the shell", () => {
    // The documented rule, and the one that matters in CI: an exported key is
    // the more deliberate signal, so a stale value on disk must not win.
    writeConfig({ apiKeys: { ABACUS_API_KEY: "from-disk" } });

    const env: NodeJS.ProcessEnv = { ABACUS_API_KEY: "from-the-shell" };

    expect(applyStoredApiKeys(env)).toEqual([]);
    expect(env.ABACUS_API_KEY).toBe("from-the-shell");
  });

  it("treats an empty exported value as absent", () => {
    // `export ABACUS_API_KEY=` is not a credential, and letting it mask the
    // stored one would be the old bug wearing a different hat.
    writeConfig({ apiKeys: { ABACUS_API_KEY: "from-disk" } });

    const env: NodeJS.ProcessEnv = { ABACUS_API_KEY: "   " };

    expect(applyStoredApiKeys(env)).toEqual(["ABACUS_API_KEY"]);
    expect(env.ABACUS_API_KEY).toBe("from-disk");
  });
});

describe("config that cannot be trusted", () => {
  it("ignores blanks, non-strings, and names that are not env vars", () => {
    // config.json is hand-editable, and this writes into the process
    // environment, so anything that isn't plainly a key is skipped rather
    // than coerced into one.
    writeConfig({
      apiKeys: {
        GOOD_KEY: "yes",
        EMPTY_KEY: "   ",
        NUMBER_KEY: 42,
        lower_case: "no",
        "PATH; rm -rf /": "no",
      },
    });

    const env: NodeJS.ProcessEnv = {};

    expect(applyStoredApiKeys(env)).toEqual(["GOOD_KEY"]);
    expect(Object.keys(env)).toEqual(["GOOD_KEY"]);
  });

  it("does nothing when there is no config at all", () => {
    const env: NodeJS.ProcessEnv = {};

    expect(applyStoredApiKeys(env)).toEqual([]);
    expect(env).toEqual({});
  });

  it("does nothing when the config is corrupt", () => {
    // A broken config must never stop the agent from starting.
    fs.writeFileSync(path.join(home, "config.json"), "{ not json", "utf8");

    expect(applyStoredApiKeys({})).toEqual([]);
  });
});
