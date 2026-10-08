import type { RunFinishedNotice } from "@abacus-ai/contract/contract/ai";
import { expect, it, vi } from "vitest";

import { fixtureSessions } from "#renderer/data/fixture-db/rows";
import { createSoundPlayer } from "#renderer/lib/sound";

import { handleSessionRunFinished } from "./notify";

it("cues one final visible reply per run and stays silent for cancellation or tool-only completion", () => {
  const row = {
    ...fixtureSessions()[0]!,
    botOwned: false,
    editorFor: null,
    routineId: null,
  };
  let now = 1000;
  const synth = vi.fn();
  const player = createSoundPlayer({
    isThreadVisible: () => false,
    isWindowFocused: () => true,
    prefs: () => ({ enabled: true, perEvent: {} }),
    now: () => now,
    synth,
  });
  const deps = {
    sessions: () => [row],
    seen: () => false,
    mark: vi.fn(),
    player,
    notifier: { notify: vi.fn() },
    labels: { done: "Done", needsYou: "Waiting" },
  };
  const notice: RunFinishedNotice = {
    threadId: row.id,
    runId: "final-reply-once",
    owner: null,
    routineId: null,
    at: 0,
    outcome: "success",
    hasVisibleAssistantText: true,
  };
  handleSessionRunFinished(deps, notice);
  now += 1000;
  handleSessionRunFinished(deps, notice);
  handleSessionRunFinished(deps, {
    ...notice,
    runId: "cancelled-reply",
    outcome: "cancelled",
  });
  handleSessionRunFinished(deps, {
    ...notice,
    runId: "tool-only-reply",
    hasVisibleAssistantText: false,
  });
  expect(synth).toHaveBeenCalledExactlyOnceWith("done");
  player.dispose();
});
