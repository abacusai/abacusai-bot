import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { act, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";
const sound = vi.hoisted(() => ({
  play: vi.fn(),
  unlock: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("#renderer/lib/sound", () => ({ createSoundPlayer: () => sound }));
const os = implement(contract);
it("cold Settings buffers fires and completions until routines hydrate and retains their subscription", async () => {
  sound.play.mockClear();
  const seed = defaultSeed();
  const row = seed.routines![0]!;
  let release!: () => void;
  let sent = false;
  const notify = vi.fn(async (_context: unknown) => {});
  const app = await renderApp("/settings/general", {
    seed,
    beforeRender(db) {
      release = db.routines.holdSnapshot();
    },
    procedures: {
      settings: {
        notifications: {
          get: os.settings.notifications.get.handler(() => ({
            enabled: true,
            sound: false,
          })),
        },
      },
      system: { notify: os.system.notify.handler(notify) },
      routines: {
        events: os.routines.events.handler(async function* ({ signal }) {
          yield {
            type: "run-started",
            routineId: row.id,
            attemptId: "early",
            trigger: "schedule",
            startedAt: 1,
          };
          sent = true;
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true })
          );
        }),
      },
    },
    runFinished: async function* () {
      yield {
        routineId: row.id,
        threadId: "early-thread",
        runId: "early-run",
        outcome: "success",
        owner: null,
        hasVisibleAssistantText: true,
        at: 1,
      };
    },
  });
  try {
    await waitFor(() => expect(sent).toBe(true));
    expect(
      sound.play.mock.calls.filter(
        ([kind]) => kind === "routine-fired" || kind === "done"
      )
    ).toEqual([]);
    await act(async () => release());
    await waitFor(() =>
      expect(sound.play).toHaveBeenCalledWith("routine-fired", {
        threadId: row.id,
        botId: row.botId,
      })
    );
    await waitFor(() =>
      expect(sound.play).toHaveBeenCalledWith("done", {
        threadId: "early-thread",
        dedupeKey: "early-run",
        botId: row.botId,
      })
    );
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            metadata: {
              kind: "routine",
              routineId: row.id,
              sessionId: "early-thread",
            },
          }),
        })
      )
    );
    expect(app.collections.routines.subscriberCount).toBeGreaterThan(0);
    await act(async () =>
      app.db.routines.upsert({ ...row, name: "Changed while in Settings" })
    );
    await waitFor(() =>
      expect(app.collections.routines.get(row.id)?.name).toBe(
        "Changed while in Settings"
      )
    );
  } finally {
    release();
    app.view.unmount();
    await app.cleanup();
  }
});
