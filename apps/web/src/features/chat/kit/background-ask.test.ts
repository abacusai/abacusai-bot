import type { UIMessage } from "@tanstack/ai-client";
import { describe, expect, it } from "vitest";

import { backgroundAskShows, backgroundAskTarget } from "./background-ask";

const fresh = {
  platform: "win32",
  keepRunning: true,
  openAtLogin: false,
  asked: false,
  trayAvailable: true,
  settled: true,
};

describe("backgroundAskShows", () => {
  it.each([
    ["a new ask, settled, the space free", null, fresh, true],
    ["not settled yet", null, { ...fresh, settled: false }, false],
    ["both already on", null, { ...fresh, openAtLogin: true }, false],
    ["on macOS", null, { ...fresh, platform: "darwin" }, false],
    [
      "on a Linux desktop with no tray",
      null,
      { ...fresh, platform: "linux", trayAvailable: false },
      false,
    ],
    ["shown under this reply", { reply: "r", answered: false }, fresh, true],
    ["answered", { reply: "r", answered: true }, fresh, false],
    [
      "shown under another reply",
      { reply: "x", answered: false },
      fresh,
      false,
    ],
    [
      "shown before, though nothing is on",
      { reply: "x", answered: true },
      { ...fresh, keepRunning: false },
      false,
    ],
  ] as const)("%s", (_case, card, state, shows) =>
    expect(backgroundAskShows(card, "r", state)).toBe(shows)
  );
});

describe("backgroundAskTarget", () => {
  const message = (id: string, role: "user" | "assistant"): UIMessage => ({
    id,
    role,
    parts: [{ type: "text", content: `${role} ${id}` }],
  });
  it.each([
    ["the latest turn's last reply", ["u1", "a1", "u2", "a2", "a3"], "a3"],
    ["a turn not answered yet", ["u1", "a1", "u2"], null],
    ["replies with no message of the user's", ["a1"], null],
  ] as const)("%s", (_case, ids, target) =>
    expect(
      backgroundAskTarget(
        ids.map((id) => message(id, id.startsWith("u") ? "user" : "assistant"))
      )
    ).toBe(target)
  );
});
