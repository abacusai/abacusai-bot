import { Store } from "@tanstack/react-store";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { DEFAULT_PREFS } from "#next/data/db/prefs";
import { fixtureBots, fixtureSessions } from "#next/data/fixture-db/rows";
import { PermissionList } from "#next/features/chat";
import { descriptor } from "#next/features/chat/fixtures/builders";
import { emptyThreadState } from "#next/features/chat/store/thread-store";
import { initI18n } from "#next/lib/i18n";
import { useNotch, type NotchRouterContext } from "#next/notch-context";

import { NotchShell, ReplyView, CallView } from "./index";
import type { NotchInputs } from "./presenter";
const f = vi.hoisted(() => ({
  inputs: null as unknown as NotchInputs,
  cancel: vi.fn(),
  receive: null as any,
}));
vi.mock("./inputs", () => ({
  useNotchInputs: (
    _t: unknown,
    app: { mainFocused: boolean },
    hovered: boolean,
    acks: ReadonlySet<string>
  ) => ({ ...f.inputs, mainFocused: app.mainFocused, hovered, acks }),
  followNotchEvents: async (_t: unknown, receive: unknown) => {
    f.receive = receive;
  },
}));
vi.mock("#next/lib/motion", async (original) => ({
  ...(await original<typeof import("#next/lib/motion")>()),
  useMotionPreference: () => "reduced",
}));
vi.mock("#next/lib/navigation/shared-element", () => ({
  useSharedElementName: () => undefined,
}));
vi.mock("#next/lib/run-finished", () => ({
  runFinishedFeed: () => ({ subscribe: () => () => {} }),
}));
vi.mock("#next/lib/sound", () => ({
  createSoundPlayer: () => ({
    dispose() {},
    play() {},
    unlock() {},
    unlocked: () => false,
  }),
}));
vi.mock("#next/lib/voice/use-dictation", () => ({
  useDictation: () => ({
    state: "recording",
    level: 0.5,
    start: async () => {},
    end: async () => {},
    cancel: f.cancel,
    error: null,
  }),
}));
const Controls = ({
  submit,
}: {
  submit: (text: string) => Promise<{ kind: string }>;
}) => {
  const n = useNotch();
  return (
    <>
      <button onClick={() => void n.message(f.inputs.bots[0]!.id, false)}>
        Launch reply
      </button>
      <button onClick={() => void n.message(f.inputs.bots[0]!.id, true)}>
        Launch listening
      </button>
      {n.presentation.route === "/reply/$id" && (
        <ReplyView text="Reply" submit={submit} />
      )}
      {n.presentation.route === "/call" && <CallView />}
      {n.presentation.route === "/approval/$id" && (
        <PermissionList runtime={n.chat} threadId="s" variant="notch" />
      )}
    </>
  );
};
beforeEach(async () => {
  await initI18n();
  f.inputs = {
    sessions: [
      {
        ...fixtureSessions()[0]!,
        id: "s",
        owner: null,
        routineId: null,
        turn: {
          phase: "waiting_permission",
          isBusy: true,
          updatedAt: "2026-10-01T00:00:00Z",
        },
      },
    ],
    bots: fixtureBots(),
    routines: [],
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
const mount = (kind = "started") => {
  const thread = emptyThreadState();
  thread.permissions.items = [
    {
      ...descriptor({
        type: "run_terminal",
        command: "pwd",
        cwd: "/work",
        background: false,
        displayName: "Needs you",
        tool: { id: "tool", name: "terminal", type: "function", input: {} },
      }),
      message: "Needs you",
    },
  ];
  const store = new Store(thread);
  const hostStore = new Store({ store });
  const session = { load: vi.fn(async () => {}), retire: vi.fn(), hostStore };
  const notch = {
    setShape: vi.fn(async () => {}),
    focus: vi.fn(async () => {}),
    setInteractive: vi.fn(async () => {}),
  };
  const context = {
    layout: {
      displayId: 1,
      mode: "plain",
      growth: "down",
      notch: null,
      maxShape: { width: 560, height: 220 },
    },
    chat: { session: () => session },
    transport: {
      client: {
        notch,
        bots: { openChat: async () => ({ sessionId: "manual" }) },
        window: { ready: async () => {} },
      },
    },
    db: { collections: { sessions: { get: () => undefined } } },
  } as unknown as NotchRouterContext;
  const submit = vi.fn(async () => ({ kind }));
  const navigate = vi.fn(async () => {});
  const tree = () => (
    <NotchShell context={context} navigate={navigate}>
      <Controls submit={submit} />
    </NotchShell>
  );
  const view = render(tree());
  return {
    ...view,
    notch,
    navigate,
    submit,
    rerenderInputs: () => view.rerender(tree()),
  };
};
it("pointer leave releases native click-through before the visual collapse delay", async () => {
  const view = mount();
  await waitFor(() => expect(view.navigate).toHaveBeenCalled());
  fireEvent.pointerLeave(screen.getByRole("region"));
  expect(view.notch.setInteractive).toHaveBeenCalledWith({
    interactive: false,
  });
});
it("pointer re-entry restores native interaction during the collapse delay", async () => {
  const view = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Launch reply" }));
  await screen.findByRole("textbox");
  const region = screen.getByRole("region");
  vi.useFakeTimers();
  try {
    fireEvent.pointerLeave(region);
    expect(view.notch.setInteractive).toHaveBeenLastCalledWith({
      interactive: false,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    fireEvent.pointerMove(region, { clientX: 0, clientY: 0 });
    expect(view.notch.setInteractive).toHaveBeenLastCalledWith({
      interactive: true,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByRole("textbox")).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});
it("expanded approval has one Needs you label", async () => {
  const view = mount();
  await waitFor(() => expect(view.navigate).toHaveBeenCalled());
  expect(screen.getAllByText("Needs you")).toHaveLength(1);
});
it.each(["reply", "listening"])(
  "current quiet hours collapse manual %s and release focus",
  async (operation) => {
    const view = mount();
    fireEvent.click(
      await screen.findByRole("button", { name: `Launch ${operation}` })
    );
    await waitFor(() =>
      expect(view.navigate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          route: operation === "reply" ? "/reply/$id" : "/call",
        })
      )
    );
    view.notch.focus.mockRejectedValueOnce(
      new Error("native focus unavailable")
    );
    f.inputs = {
      ...f.inputs,
      prefs: {
        ...DEFAULT_PREFS,
        sounds: {
          ...DEFAULT_PREFS.sounds,
          quietHours: { enabled: true, start: "00:00", end: "23:59" },
        },
      },
      now: new Date(2026, 9, 1, 12).getTime(),
    };
    view.rerenderInputs();
    await waitFor(() =>
      expect(view.navigate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          route: "/idle",
          quietUntil: "23:59",
          expanded: false,
        })
      )
    );
    expect(view.notch.focus).toHaveBeenLastCalledWith({ focus: false });
    f.inputs = { ...f.inputs, prefs: DEFAULT_PREFS };
    view.rerenderInputs();
    await waitFor(() =>
      expect(view.navigate).toHaveBeenLastCalledWith(
        expect.objectContaining({ route: "/approval/$id" })
      )
    );
    expect(screen.queryByRole("textbox")).toBeNull();
  }
);
it.each(["started", "queued"])(
  "successful %s manual reply collapses and releases native focus",
  async (kind) => {
    const view = mount(kind);
    fireEvent.click(
      await screen.findByRole("button", { name: "Launch reply" })
    );
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "Hello" } });
    // Attention elsewhere can now advance after this manually opened reply.
    f.inputs = { ...f.inputs, sessions: [] };
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(view.submit).toHaveBeenCalledWith("Hello"));
    await waitFor(() =>
      expect(view.notch.focus).toHaveBeenLastCalledWith({ focus: false })
    );
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(
      screen
        .getAllByRole("img")
        .some((image) => image.getAttribute("data-mood") === "wink")
    ).toBe(true);
    await act(async () =>
      f.receive({ type: "app", mainVisible: false, mainFocused: false })
    );
  }
);

it("accepted automatic reply acknowledges its run so unchanged notices cannot expand it again", async () => {
  const owner = {
    kind: "bot" as const,
    key: "forever",
    botId: f.inputs.bots[0]!.id,
    role: "forever" as const,
  };
  f.inputs = {
    ...f.inputs,
    sessions: [
      {
        ...f.inputs.sessions[0]!,
        owner,
        turn: {
          isBusy: false,
          phase: "idle",
          updatedAt: "2026-10-01T00:00:00Z",
        },
      },
    ],
    notices: [
      {
        notice: {
          threadId: "s",
          runId: "reply-run",
          owner,
          routineId: null,
          at: Date.parse("2026-10-01T00:00:01Z"),
          outcome: "success",
          hasVisibleAssistantText: true,
        },
        age: 0,
      },
    ],
  };
  const view = mount();
  const input = await screen.findByRole("textbox");
  fireEvent.change(input, { target: { value: "Thanks" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  view.rerenderInputs();
  await waitFor(() =>
    expect(view.navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ route: "/idle" })
    )
  );
  expect(view.notch.focus).toHaveBeenLastCalledWith({ focus: false });
});
