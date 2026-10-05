/**
 * The bot loop under `--wire agui` (spec §4, §7.7): AG-UI text is the
 * sanitiser's output, `<think>` becomes reasoning, the user's run settles
 * before housekeeping, and a hidden housekeeping turn adds nothing to AG-UI
 * while compat keeps what the bot leaks today.
 */
import * as fs from "node:fs";
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
      setup: () => {
        // A daily note makes the consolidation turn due after this reply.
        fs.mkdirSync(path.join(BOT_DIR, "memory"), { recursive: true });
        fs.writeFileSync(
          path.join(BOT_DIR, "memory", "2026-01-01.md"),
          "- met the user\n"
        );
      },
      reply: (index) =>
        index === 0
          ? { say: "<think>pondering</think><reply>Hi there</reply>" }
          : { say: "NO_REPLY" },
    });

    try {
      l.send(runInput("r1", "hello bot"));
      await l.waitFor(hasType("RUN_FINISHED"), "user run finished");
      await l.waitFor(() => l.providerCalls() >= 2, "housekeeping turn");
      await l.waitFor((events) => {
        const last = events.at(-1);

        return last?.type === "CUSTOM" && last.name === "agent.status";
      }, "host idle");
      await new Promise((resolve) => setTimeout(resolve, 200));

      const events = l.events();
      const inRun = events.slice(
        events.findIndex((event) => event.type === "RUN_STARTED"),
        events.findIndex((event) => event.type === "RUN_FINISHED") + 1
      );
      const assistantText = inRun
        .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
        .map((event) => (event as { delta: string }).delta)
        .filter((delta) => delta !== "hello bot")
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

      // After the user's terminal: nothing run-scoped, and no status from
      // inside the hidden turn; only the host's own idle at the very end.
      const after: AguiEvent[] = events.slice(
        events.findIndex((event) => event.type === "RUN_FINISHED") + 1
      );

      expect(after.filter((event) => isRunScoped(event))).toEqual([]);
      expect(
        after.map((event) =>
          event.type === "CUSTOM" ? event.name : event.type
        )
      ).toEqual(["agent.status"]);
      // Compat still carries what the bot emits during housekeeping today.
      const compatAfterUserTurn = l.compat().length;

      expect(compatAfterUserTurn).toBeGreaterThan(0);
    } finally {
      await l.close();
    }
  });
});
