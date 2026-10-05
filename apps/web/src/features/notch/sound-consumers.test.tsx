import type { RunFinishedNotice } from "@abacus-ai/contract/contract";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Store } from "@tanstack/react-store";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { DEFAULT_PREFS } from "#renderer/data/db/prefs";
import {
  fixtureBots,
  fixtureRoutines,
  fixtureSessions,
} from "#renderer/data/fixture-db/rows";
import { emptyThreadState } from "#renderer/features/chat/store/thread-store";
import { RoutinesGlobals } from "#renderer/features/routines/globals";
import { initI18n } from "#renderer/lib/i18n";
import type { NotchRouterContext } from "#renderer/notch-context";

import { NotchShell } from "./index";
import type { NotchInputs } from "./presenter";

const f = vi.hoisted(() => ({
  inputs: null as unknown as NotchInputs,
  app: null as any,
  streams: new Map<string, (event: any) => void>(),
  finished: new Set<(notice: RunFinishedNotice) => void>(),
  synths: [] as ReturnType<typeof vi.fn>[],
}));
vi.mock("#renderer/lib/use-app-context", () => ({
  useAppContext: () => f.app,
}));
vi.mock("./inputs", () => ({
  useNotchInputs: (
    _t: unknown,
    app: { mainFocused: boolean },
    hovered: boolean,
    acks: ReadonlySet<string>
  ) => ({ ...f.inputs, mainFocused: app.mainFocused, hovered, acks }),
  followNotchEvents: async () => {},
}));
vi.mock("#renderer/lib/motion", () => ({
  useMotionPreference: () => "reduced",
}));
vi.mock("#renderer/lib/navigation/shared-element", () => ({
  useSharedElementName: () => undefined,
}));
vi.mock("#renderer/data/queries/live", () => {
  const followNotices = async (
    _t: unknown,
    subscribe: any,
    receive: any,
    signal: AbortSignal
  ) => {
    f.streams.set(await subscribe({ signal }), receive);
  };
  return {
    followNotices,
    followAttention: (t: any, receive: any, signal: AbortSignal) =>
      void followNotices(
        t,
        (options: unknown) => t.client.ai.attention({}, options),
        receive,
        signal
      ),
    followConnectorEvents: (t: any, receive: any, signal: AbortSignal) =>
      void followNotices(
        t,
        (options: unknown) => t.client.connectors.events({}, options),
        receive,
        signal
      ),
  };
});
vi.mock("#renderer/lib/run-finished", () => {
  const subscribe = (receive: (notice: RunFinishedNotice) => void) => {
    f.finished.add(receive);
    return () => f.finished.delete(receive);
  };
  return {
    runFinishedFeed: () => ({ subscribe }),
    subscribeRunFinished: (_t: unknown, receive: any) => subscribe(receive),
  };
});
// Each consumer represents a separate document. Keep the real sound gates and
// claims, but give each its own audio engine so document coalescing cannot hide a duplicate.
vi.mock("#renderer/lib/sound", async (original) => {
  const sound = await original<typeof import("#renderer/lib/sound")>();
  return {
    ...sound,
    createSoundPlayer: (ctx: import("#renderer/lib/sound").SoundContext) => {
      const synth = vi.fn();
      f.synths.push(synth);
      return sound.createSoundPlayer({
        ...ctx,
        synth,
        createAudioContext: () => ({
          state: "running",
          resume: async () => {},
        }),
      });
    },
  };
});
beforeEach(async () => {
  await initI18n();
  f.streams.clear();
  f.finished.clear();
  f.synths = [];
  f.inputs = {
    sessions: [],
    bots: fixtureBots(),
    routines: fixtureRoutines(),
    summaries: new Map(),
    asks: [],
    notices: [],
    prefs: DEFAULT_PREFS,
    mainFocused: false,
    hovered: false,
    acks: new Set(),
    snoozed: new Set(),
  };
});
const mount = async () => {
  const routine = f.inputs.routines[0]!;
  const session = {
    ...fixtureSessions()[0]!,
    id: "s",
    routineId: routine.id,
    owner: null,
    turn: {
      phase: "idle" as const,
      isBusy: false,
      updatedAt: "2026-10-01T00:00:00Z",
    },
  };
  f.inputs = { ...f.inputs, sessions: [session] };
  const claimed = new Set<string>();
  const claimCue = vi.fn(
    async ({ cueId }: { cueId: string; threadId: string | null }) => {
      const play = !claimed.has(cueId);
      claimed.add(cueId);
      return { play };
    }
  );
  const collection = (rows: any[]) => ({
    get: (id: string) => rows.find((row) => row.id === id),
    toArray: rows,
    preload: async () => {},
    subscribeChanges: () => ({ unsubscribe() {} }),
  });
  const transport = {
    client: {
      window: { ready: async () => {}, claimCue },
      notch: { setShape: async () => {}, setInteractive: async () => {} },
      ai: { attention: async () => "attention" },
      routines: { events: async () => "routines" },
      connectors: { events: async () => "connectors" },
      system: { notify: async () => {} },
    },
    orpc: {
      settings: {
        notifications: {
          get: {
            queryOptions: () => ({
              queryKey: ["notifications"],
              queryFn: async () => ({ enabled: true }),
            }),
            queryKey: () => ["notifications"],
          },
        },
      },
    },
  };
  const db = {
    collections: {
      routines: collection([routine]),
      sessions: collection([session]),
      prefs: collection([{ id: "app", sounds: DEFAULT_PREFS.sounds }]),
    },
  };
  f.app = { transport, db };
  const context = {
    transport,
    db,
    layout: {
      displayId: 1,
      mode: "plain",
      growth: "down",
      notch: null,
      maxShape: { width: 560, height: 220 },
    },
    chat: {
      session: () => ({
        load: async () => {},
        retire() {},
        hostStore: new Store({ store: new Store(emptyThreadState()) }),
      }),
    },
  } as unknown as NotchRouterContext;
  const tree = () => (
    <QueryClientProvider client={cache}>
      <RoutinesGlobals />
      <NotchShell context={context} navigate={async () => {}}>
        <span />
      </NotchShell>
    </QueryClientProvider>
  );
  const cache = new QueryClient();
  const view = render(tree());
  fireEvent.pointerDown(document);
  fireEvent.pointerDown(screen.getByRole("region"));
  await act(async () => {});
  await waitFor(() => expect(f.streams.size).toBe(3));
  return {
    ...view,
    routine,
    session,
    claimCue,
    rerenderInputs: () => view.rerender(tree()),
  };
};
it.each(["success", "error"] as const)(
  "routine %s completion is claimed once across both production consumers",
  async (outcome) => {
    const view = await mount();
    const notice: RunFinishedNotice = {
      routineId: view.routine.id,
      threadId: "s",
      runId: "run",
      outcome,
      owner: null,
      hasVisibleAssistantText: true,
      at: Date.now(),
    };
    await act(async () => {
      for (const receive of f.finished) receive(notice);
    });
    const kind = outcome === "error" ? "failed" : "done";
    expect(view.claimCue.mock.calls.map(([input]) => input)).toEqual([
      { cueId: `${kind}:run`, threadId: "s" },
      { cueId: `${kind}:run`, threadId: "s" },
    ]);
    expect(f.synths.flatMap((synth) => synth.mock.calls)).toEqual([[kind]]);
  }
);
it("routine permission attention uses the same claim in both production consumers", async () => {
  const view = await mount();
  const item = {
    threadId: "s",
    incarnation: "agent",
    oldestAt: 123,
    approvals: 1,
    questions: 0,
    firstTitle: "Permission",
  };
  f.inputs = {
    ...f.inputs,
    sessions: [
      {
        ...view.session,
        turn: {
          phase: "waiting_permission",
          isBusy: true,
          updatedAt: "2026-10-01T00:00:01Z",
        },
      },
    ],
    summaries: new Map([["s", item]]),
  };
  await act(async () => {
    f.streams.get("attention")!({ type: "upsert", revision: 1, item });
    view.rerenderInputs();
  });
  expect(view.claimCue.mock.calls.map(([input]) => input)).toEqual([
    { cueId: "needs-you:s:agent:123", threadId: "s" },
    { cueId: "needs-you:s:agent:123", threadId: "s" },
  ]);
  expect(f.synths.flatMap((synth) => synth.mock.calls)).toEqual([
    ["needs-you"],
  ]);
});
it("routine connector attention uses the same request claim in both production consumers", async () => {
  const view = await mount();
  f.inputs = {
    ...f.inputs,
    asks: [{ id: "request", sessionId: "s", since: Date.now() }],
  };
  await act(async () => {
    f.streams.get("connectors")!({
      type: "request",
      request: {
        requestId: "request",
        conversationKey: sessionConversationKey("w", "s"),
      },
    });
    view.rerenderInputs();
  });
  expect(view.claimCue.mock.calls.map(([input]) => input)).toEqual([
    { cueId: "needs-you:request", threadId: "s" },
    { cueId: "needs-you:request", threadId: "s" },
  ]);
  expect(f.synths.flatMap((synth) => synth.mock.calls)).toEqual([
    ["needs-you"],
  ]);
});
