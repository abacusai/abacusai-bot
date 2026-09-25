/**
 * The cooldowns that outlive a session, and what concurrency does to them.
 *
 * Every chat is its own agent process, so this file is the only thing standing
 * between a user and rediscovering a saturated model (by failing on it) at
 * the start of every new chat.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fileCooldownStore } from "./openllm-cooldowns.js";

const MODEL = "openrouter/z-ai/glm-5.2:free";

let dir: string;
let file: string;
let clock: number;

const store = () => fileCooldownStore(() => clock, file);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-cooldowns-"));
  file = path.join(dir, "openllm-cooldowns.json");
  clock = 1_000_000;
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the cooldown file", () => {
  it("hands a later session what an earlier one learned", () => {
    store().write({ [MODEL]: { until: clock + 60_000, failures: 2 } });

    expect(store().read()[MODEL]).toEqual({
      until: clock + 60_000,
      failures: 2,
    });
  });

  it("forgets a cooldown once it has expired", () => {
    store().write({ [MODEL]: { until: clock + 60_000, failures: 2 } });
    clock += 61_000;

    expect(store().read()[MODEL]).toBeUndefined();
  });

  it("keeps the longer of two concurrent sessions' cooldowns", () => {
    // Both sessions rewrite the whole file. The one that started earlier must
    // not be able to erase what the other just found out.
    store().write({ [MODEL]: { until: clock + 3_600_000, failures: 3 } });
    store().write({ [MODEL]: { until: clock + 60_000, failures: 1 } });

    expect(store().read()[MODEL]).toEqual({
      until: clock + 3_600_000,
      failures: 3,
    });
  });

  it("starts from nothing rather than throwing on a corrupt file", () => {
    fs.writeFileSync(file, "{not json", "utf8");

    expect(store().read()).toEqual({});
    expect(() =>
      store().write({ [MODEL]: { until: clock + 1, failures: 1 } })
    ).not.toThrow();
  });

  it("reads nothing, quietly, when there is no file at all", () => {
    expect(store().read()).toEqual({});
  });

  it("drops entries that are not shaped like a cooldown", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ [MODEL]: "yesterday", other: { until: clock + 5 } }),
      "utf8"
    );

    expect(store().read()).toEqual({});
  });
});
