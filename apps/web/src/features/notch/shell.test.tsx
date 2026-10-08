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
import { fixtureBots, fixtureSessions } from "#renderer/data/fixture-db/rows";
import { PermissionList } from "#renderer/features/chat";
import { descriptor } from "#renderer/features/chat/fixtures/builders";
import { emptyThreadState } from "#renderer/features/chat/store/thread-store";
import { initI18n } from "#renderer/lib/i18n";
import { useNotch, type NotchRouterContext } from "#renderer/notch-context";

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
vi.mock("#renderer/lib/motion", async (original) => ({
  ...(await original<typeof import("#renderer/lib/motion")>()),
  useMotionPreference: () => "reduced",
}));
vi.mock("#renderer/lib/navigation/shared-element", () => ({
  useSharedElementName: () => undefined,
}));
vi.mock("#renderer/lib/run-finished", () => ({
  runFinishedFeed: () => ({ subscribe: () => () => {} }),
}));
vi.mock("#renderer/lib/sound", () => ({
  createSoundPlayer: () => ({
    dispose() {},
    play() {},
    unlock() {},
    unlocked: () => false,
  }),
}));
vi.mock("#renderer/lib/voice/use-dictation", () => ({
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
  vi.restoreAllMocks();
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
  f.inputs = { ...f.inputs, sessions: [] };
  const view = mount();
  await waitFor(() => expect(view.navigate).toHaveBeenCalled());
  fireEvent.pointerLeave(screen.getByRole("region"));
  expect(view.notch.setInteractive).toHaveBeenCalledWith({
    interactive: false,
  });
});
it("reply remains interactive and mounted when the pointer leaves", async () => {
  const view = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Launch reply" }));
  await screen.findByRole("textbox");
  const region = screen.getByRole("region");
  vi.useFakeTimers();
  try {
    fireEvent.pointerLeave(region);
    expect(view.notch.setInteractive).toHaveBeenLastCalledWith({
      interactive: true,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
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
it.each([false, true])(
  "pending quiet-hours focus release cannot restore or erase manual views (replacement=%s)",
  async (replacement) => {
    const view = mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Launch reply" })
    );
    await screen.findByRole("textbox");
    await waitFor(() =>
      expect(view.notch.focus).toHaveBeenLastCalledWith(
        { focus: true },
        expect.anything()
      )
    );
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    fireEvent(window, new Event("focus"));
    expect(document.querySelector('[aria-live="polite"]')).toBeTruthy();
    let release!: () => void;
    view.notch.focus.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
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
        expect.objectContaining({ route: "/idle", quietUntil: "23:59" })
      )
    );
    expect(document.querySelector('[aria-live="polite"]')).toBeNull();
    f.inputs = { ...f.inputs, prefs: DEFAULT_PREFS };
    view.rerenderInputs();
    if (replacement) {
      fireEvent.click(
        await screen.findByRole("button", { name: "Launch listening" })
      );
      await waitFor(() =>
        expect(view.navigate).toHaveBeenLastCalledWith(
          expect.objectContaining({ route: "/call" })
        )
      );
    } else {
      await waitFor(() =>
        expect(view.navigate).toHaveBeenLastCalledWith(
          expect.objectContaining({ route: "/approval/$id" })
        )
      );
      expect(screen.queryByRole("textbox")).toBeNull();
    }
    if (replacement) {
      fireEvent(window, new Event("focus"));
    }
    await act(async () => release());
    expect(Boolean(document.querySelector('[aria-live="polite"]'))).toBe(
      replacement
    );
    expect(view.navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        route: replacement ? "/call" : "/approval/$id",
      })
    );
  }
);
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

it("approval keeps mouse interaction without taking typing focus", async () => {
  const view = mount();
  await waitFor(() => expect(view.navigate).toHaveBeenCalled());
  fireEvent.pointerLeave(screen.getByRole("region"));
  expect(view.notch.setInteractive).toHaveBeenLastCalledWith({
    interactive: true,
  });
  expect(view.notch.focus).not.toHaveBeenCalledWith({ focus: true });
});
it("the fixed surface stays the same size when a reply expands and closes", async () => {
  f.inputs = { ...f.inputs, sessions: [] };
  const view = mount();
  const surface = screen.getByRole("region");
  const size = [surface.style.width, surface.style.height];
  act(() => f.receive({ type: "shortcut" }));
  fireEvent.click(await screen.findByRole("button", { name: "Launch reply" }));
  await screen.findByRole("textbox");
  expect([surface.style.width, surface.style.height]).toEqual(size);
  fireEvent.keyDown(surface, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  expect(view.notch.focus).toHaveBeenLastCalledWith({ focus: false });
  expect([surface.style.width, surface.style.height]).toEqual(size);
});
it("forwarded movement through transparent margins releases mouse routing", async () => {
  f.inputs = { ...f.inputs, sessions: [] };
  const view = mount();
  await waitFor(() => expect(view.navigate).toHaveBeenCalled());
  const shape = document.querySelector(".notch-shape")!;
  const hit = vi.fn().mockReturnValue(shape);
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: hit,
  });
  fireEvent.pointerMove(window, { clientX: 280, clientY: 10 });
  expect(view.notch.setInteractive).toHaveBeenLastCalledWith({
    interactive: true,
  });
  hit.mockReturnValue(document.body);
  fireEvent.pointerMove(window, { clientX: 10, clientY: 200 });
  expect(view.notch.setInteractive).toHaveBeenLastCalledWith({
    interactive: false,
  });
});

it("reply keeps input, voice and send icons inside one inset pill", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Launch reply" }));
  const input = await screen.findByRole("textbox");
  const pill = input.closest(".notch-reply-pill");
  expect(pill).toBeTruthy();
  const send = screen.getByRole("button", { name: "Send" });
  expect(pill?.contains(send)).toBe(true);
  expect(send.textContent).toBe("");
  expect(pill?.querySelectorAll("button svg").length).toBe(3);
});

it("a rejected reply keeps editable text below one alert and clears it on edit", async () => {
  const view = mount("rejected");
  fireEvent.click(await screen.findByRole("button", { name: "Launch reply" }));
  const input = await screen.findByRole("textbox");
  fireEvent.change(input, { target: { value: "Keep this reply" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(view.submit).toHaveBeenCalledWith("Keep this reply")
  );
  const alert = await screen.findByRole("alert");
  expect(alert.getAttribute("aria-live")).toBe("assertive");
  expect(
    alert.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  expect((input as HTMLInputElement).value).toBe("Keep this reply");
  expect(input.hasAttribute("disabled")).toBe(false);
  expect(
    alert.closest('[data-slot="send-error"]')?.classList.contains("w-full")
  ).toBe(true);
  fireEvent.change(input, { target: { value: "Retry this reply" } });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
