/**
 * The bot loop under `--wire agui` (spec §4, §7.7): AG-UI text is the
 * sanitiser's output, `<think>` becomes reasoning, the user's run settles
 * before housekeeping, and a hidden housekeeping turn adds nothing to AG-UI
 * while compat keeps what the bot leaks today.
 */
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { GOLDEN_ROOT, stopProvider } from "./__tests__/harness.js";
import { hasType, live, runInput } from "./__tests__/live.js";
import { isRunScoped } from "./event.js";
import type { AguiEvent } from "./wire.js";

const BOT_DIR = path.join(GOLDEN_ROOT, "home", "bots", "bot-1");

afterAll(async () => {
  await stopProvider();
});

describe("bot", () => {
  it("streams sanitised text, closes the user's run before housekeeping, and hides the hidden turn", async () => {
    const l = await live({
      realSessionChoice: true,
      env: { ABACUSAI_BOT_BOT_DIR: BOT_DIR, PI_OFFLINE: "1" },
      reply: (index) =>
        index === 0
          ? { say: "<think>pondering</think><reply>Hi there</reply>" }
          : { say: "NO_REPLY" },
    });

    try {
      // Asked to remember, the reply saves nothing: the save check is the housekeeping turn.
      l.send(runInput("r1", "remember I take my tea black"));
      await l.waitFor(hasType("RUN_FINISHED"), "user run finished");
      await l.waitFor(() => l.providerCalls() >= 2, "housekeeping turn");
      // The hidden turn's end reaches compat as its usage only.
      await l.waitFor(
        () =>
          l
            .compat()
            .filter(
              (event) =>
                event.type === "event" && event.event.type === "turn_complete"
            ).length === 2,
        "housekeeping done"
      );
      await new Promise((resolve) => setTimeout(resolve, 200));

      const events = l.events();
      const inRun = events.slice(
        events.findIndex((event) => event.type === "RUN_STARTED"),
        events.findIndex((event) => event.type === "RUN_FINISHED") + 1
      );
      const assistantText = inRun
        .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
        .map((event) => (event as { delta: string }).delta)
        .filter((delta) => delta !== "remember I take my tea black")
        .join("");
      const compatText = l
        .compat()
        .filter(
          (event) => event.type === "event" && event.event.type === "text_delta"
        )
        .map((event) => (event as { event: { content: string } }).event.content)
        .join("");

      expect(assistantText).not.toMatch(/<\/?(think|thinking|reasoning)>/);
      expect(assistantText).toBe(compatText);
      const reasoning = inRun
        .filter((event) => event.type === "REASONING_MESSAGE_CONTENT")
        .map((event) => (event as { delta: string }).delta)
        .join("");

      expect(reasoning).toContain("pondering");

      // After the user's terminal: nothing at all. The hidden turn shows no
      // status, and the user's turn already said idle.
      const after: AguiEvent[] = events.slice(
        events.findIndex((event) => event.type === "RUN_FINISHED") + 1
      );

      expect(after.filter((event) => isRunScoped(event))).toEqual([]);
      expect(
        after.map((event) =>
          event.type === "CUSTOM" ? event.name : event.type
        )
      ).toEqual([]);
      // Compat still carries what the bot emits during housekeeping today.
      const compatAfterUserTurn = l.compat().length;

      expect(compatAfterUserTurn).toBeGreaterThan(0);
    } finally {
      await l.close();
    }
  });

  it("runs no memory housekeeping in a held chat: nobody there asked to keep anything", async () => {
    const l = await live({
      realSessionChoice: true,
      mode: "UNATTENDED",
      env: { ABACUSAI_BOT_BOT_DIR: BOT_DIR, PI_OFFLINE: "1" },
      reply: () => ({ say: "<reply>Hi there</reply>" }),
    });

    try {
      l.send(runInput("r1", "remember I take my tea black"));
      await l.waitFor(hasType("RUN_FINISHED"), "user run finished");
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(l.providerCalls()).toBe(1);
    } finally {
      await l.close();
    }
  });
});
