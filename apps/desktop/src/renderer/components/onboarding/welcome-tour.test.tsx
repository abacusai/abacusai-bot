import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, JSX, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkspaceStore } from "../../stores/code-store";
import { useTourStore } from "../../stores/tour-store";

const navigate = vi.hoisted(() => vi.fn());
const start = vi.hoisted(() => vi.fn());
const tourProps = vi.hoisted(() => ({
  current: null as ComponentProps<
    typeof import("react-tourlight").SpotlightTour
  > | null,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: "/" } }),
}));

vi.mock("react-tourlight", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-tourlight")>();
  return {
    ...actual,
    SpotlightProvider: ({ children }: { children: ReactNode }) => children,
    SpotlightTour: (props: typeof tourProps.current) => {
      tourProps.current = props;
      return null;
    },
    // Tourlight's context changes as the active step changes, so its control
    // hook returns a new callback. Model that here to catch accidental restarts.
    useSpotlightControl: () => ({
      start: (tourId: string) => start(tourId),
    }),
  };
});

const abacusAccount = vi.hoisted(() =>
  vi.fn(() => ({ isPending: false, data: null }))
);
const workspaceMetadata = vi.hoisted(() =>
  vi.fn(() => ({ data: { workspaces: [{ id: "w1", status: "ready" }] } }))
);

vi.mock("../../hooks/use-abacus-account", () => ({
  useAbacusAccountQuery: () => abacusAccount(),
}));

vi.mock("../../hooks/use-workspace-queries", () => ({
  useWorkspaceMetadataQuery: () => workspaceMetadata(),
}));

// One stable `t`, as the real i18next instance gives: it changes on a
// language switch and not on every render. The steps memo is keyed on it,
// and a `t` that changed per render would hide the thing the identity test
// below is there to catch.
vi.mock("react-i18next", () => {
  const t = (
    key: string,
    values?: { current: number; total: number }
  ): string => (values == null ? key : `${values.current}/${values.total}`);
  return { useTranslation: () => ({ t }) };
});

const { TourTooltip, WelcomeTour, WelcomeTourGate } =
  await import("./welcome-tour");
const { useAccountStore } = await import("../../stores/account-store");

describe("TourTooltip", () => {
  it("uses the shadcn card controls supplied by Tourlight", () => {
    const next = vi.fn();
    // Index 1: the opening stop covers two things and draws its own rows, so
    // it is the wrong place to check that a step's body is rendered at all.
    render(
      (
        <TourTooltip
          step={{ target: "#target", title: "Title", content: "Body" }}
          next={next}
          previous={vi.fn()}
          skip={vi.fn()}
          currentIndex={1}
          totalSteps={4}
        />
      ) as JSX.Element
    );

    expect(screen.getByText("Title")).toBeTruthy();
    expect(screen.getByText("Body")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "2"
    );
    fireEvent.click(screen.getByText("tour.next"));
    expect(next).toHaveBeenCalledOnce();
  });

  it("opens on the pair, as two rows rather than a paragraph", () => {
    // Bots and sessions are one answer to "what is this list" — the stop says
    // both, and a stop that says both should not read as one run-on sentence.
    render(
      (
        <TourTooltip
          step={{ target: "#target", title: "Title", content: "Body" }}
          next={vi.fn()}
          previous={vi.fn()}
          skip={vi.fn()}
          currentIndex={0}
          totalSteps={4}
        />
      ) as JSX.Element
    );

    expect(
      document.querySelector('[data-id="welcome-tour-bullets"]')
    ).toBeTruthy();
    expect(screen.queryByText("Body")).toBeNull();
  });
});

describe("WelcomeTour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tourProps.current = null;
    useTourStore.setState({ isOpen: true });
  });

  it("hands Tourlight the same steps array across renders", async () => {
    // SpotlightTour registers the tour in an effect keyed on `steps`, and
    // that effect's cleanup unregisters it. A fresh array per render stops
    // the running tour — which killed every lap at step 2, whose own
    // navigation guarantees a re-render, and dropped the user on the home
    // page with steps 3 and 4 never shown.
    const view = render(<WelcomeTour />);
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith("workspace-onboarding")
    );

    const first = tourProps.current?.steps;
    view.rerender(<WelcomeTour />);

    expect(tourProps.current?.steps).toBe(first);
  });

  it("keeps every stop on the workspace it is describing", async () => {
    render(<WelcomeTour />);
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith("workspace-onboarding")
    );

    const steps = tourProps.current?.steps ?? [];
    // The bots tree, which is always rendered — the lap used to open on the
    // sessions list, a target that did not exist when the sidebar was showing
    // bots, and hung the tour on a bare overlay.
    expect(steps[0]?.target).toBe('[data-id="sidebar-lists"]');
    // Nothing leaves the workspace shell. The bot-maker stop carries no route
    // at all — it navigates itself, so that nothing lands between its wait
    // for the field and Tourlight measuring it.
    expect(new Set(steps.map((step) => step.route))).toEqual(
      new Set(["/", undefined])
    );
  });

  it("spotlights nothing the window does not render", async () => {
    // The settings-rail stop targeted an element only the focused settings
    // layout puts on screen, and /settings/connectors does not. Tourlight waits
    // two seconds for a target before skipping the step, so the lap hung there
    // every time on its way to the last card.
    render(<WelcomeTour />);
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith("workspace-onboarding")
    );

    const targets = (tourProps.current?.steps ?? []).map((step) => step.target);
    expect(targets).not.toContain('[data-id="settings-navigation"]');
  });

  it("captions the stop for the thing it lights up", async () => {
    render(<WelcomeTour />);
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith("workspace-onboarding")
    );

    const step = (tourProps.current?.steps ?? [])[1];

    // A first run lands on the bot maker, so this stop spotlights "Create
    // Bot". It used to carry the composer's caption — a sentence about running
    // commands in a workspace, over a name field.
    expect(step?.title).toBe("tour.steps.makeBot.title");
    expect(step?.content).toBe("tour.steps.makeBot.body");
  });

  it("puts the bot maker on screen rather than hoping for it", async () => {
    render(<WelcomeTour />);
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith("workspace-onboarding")
    );

    const step = (tourProps.current?.steps ?? [])[1];

    // The pane this stop would otherwise inherit can be a channel bot's chat,
    // which is read-only: no composer, no name field, and the stop dimmed the
    // whole window over nothing. So the step goes and gets its own pane.
    expect(step?.target).toBe('[data-id="bots-home-name-input"]');
    // No route: the provider navigates after onBeforeStep and measures right
    // after, so a route here put a second navigation between the stop's wait
    // for the field and the measurement of it, and the spotlight landed on
    // the corner of the window. The stop navigates itself instead.
    expect(step?.route).toBeUndefined();

    void step?.onBeforeStep?.();
    const store = useWorkspaceStore.getState();
    expect(store.newPaneIntent).toBe("bot");
    expect(store.getActiveSessionId(store.activeWorkspaceId)).toBeNull();
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/bots/new" })
    );
  });

  it("is the four stops on the window, and nothing else", async () => {
    render(<WelcomeTour />);
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith("workspace-onboarding")
    );

    const targets = (tourProps.current?.steps ?? []).map((step) => step.target);

    expect(targets).toEqual([
      '[data-id="sidebar-lists"]',
      // The maker, which this stop navigates to itself.
      '[data-id="bots-home-name-input"]',
      '[data-id="sidebar-nav-connectors"]',
      // The toggle renders on the bots pane again, scoped to the bot folder,
      // so this stop has a target on the screen the tour actually runs on.
      '[data-id="local-code-bottom-panel-toggle"]',
    ]);
    // The models stop and the profile card the lap used to end on are gone:
    // neither is something a first run has to be walked through, and the
    // profile one ended the tour on a settings page.
    expect(targets).not.toContain('[data-id="settings-menu-trigger"]');
    expect(targets).not.toContain('[data-id="profile-account-card"]');
  });

  it("starts only once when Tourlight refreshes its control context", async () => {
    const view = render(<WelcomeTour />);
    await waitFor(() => expect(start).toHaveBeenCalledOnce());

    view.rerender(<WelcomeTour />);
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(start).toHaveBeenCalledOnce();
  });

  it("keeps its callbacks stable while the flow re-renders around it", async () => {
    // Tourlight registers the tour in an effect keyed on its callbacks, and
    // that effect's cleanup unregisters — which stops a tour already running.
    // The onboarding flow passes an inline `onFinish`, so a new one on every
    // render tore the lap down a frame after it started: Continue on the models
    // screen dropped the overlay, no spotlight ever appeared, and onboarding
    // was never recorded as finished.
    const view = render(<WelcomeTour onFinish={() => undefined} />);
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    const first = tourProps.current;

    view.rerender(<WelcomeTour onFinish={() => undefined} />);

    expect(tourProps.current?.onComplete).toBe(first?.onComplete);
    expect(tourProps.current?.onSkip).toBe(first?.onSkip);
  });

  it("calls the latest onFinish rather than the one it was mounted with", () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const view = render(<WelcomeTour onFinish={stale} />);

    view.rerender(<WelcomeTour onFinish={fresh} />);
    tourProps.current?.onComplete?.();

    expect(fresh).toHaveBeenCalledOnce();
    expect(stale).not.toHaveBeenCalled();
  });

  it("closes the lap and returns to the workspace", () => {
    const { unmount } = render(<WelcomeTour />);

    tourProps.current?.onComplete?.();
    expect(useTourStore.getState().isOpen).toBe(false);
    unmount();

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/", replace: true })
    );
  });
});

/**
 * The regression this file exists for.
 *
 * An existing user relaunched to take an update and got the whole welcome
 * tour. The gate started a lap whenever the persisted "already seen" flag was
 * missing, and an update moved Electron's userData into the account profile —
 * which left every install's localStorage behind. `onboarded` lives in the
 * main process's account file, so it survived: the app correctly showed no
 * onboarding, and then spotlighted the sidebar for somebody on their
 * two-hundredth launch.
 *
 * Every case below is an onboarded user with a workspace — precisely the
 * state the gate used to fire on. Nothing but an explicit `open()` may start
 * a tour now, so no storage that clears and no edit to the stops can bring
 * it back.
 */
describe("WelcomeTourGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tourProps.current = null;
    useTourStore.setState({ isOpen: false, runId: 0 });
    useAccountStore.setState({ loaded: true, onboarded: true });
  });

  it("shows an existing user nothing, however empty their storage is", async () => {
    window.localStorage.clear();
    render(<WelcomeTourGate />);

    await waitFor(() => expect(useAccountStore.getState().loaded).toBe(true));
    expect(start).not.toHaveBeenCalled();
    expect(useTourStore.getState().isOpen).toBe(false);
  });

  it("stays down across a re-render, rather than starting a lap late", async () => {
    const view = render(<WelcomeTourGate />);
    view.rerender(<WelcomeTourGate />);

    await waitFor(() => expect(useAccountStore.getState().loaded).toBe(true));
    expect(start).not.toHaveBeenCalled();
  });

  it("still renders the replay the settings menu asks for", async () => {
    render(<WelcomeTourGate />);
    expect(start).not.toHaveBeenCalled();

    useTourStore.getState().open();

    await waitFor(() =>
      expect(start).toHaveBeenCalledWith("workspace-onboarding")
    );
  });

  it("stands down while onboarding owns the tour", () => {
    useTourStore.setState({ isOpen: true });
    render(<WelcomeTourGate suppressed />);

    expect(start).not.toHaveBeenCalled();
  });

  it("waits for the account read before deciding anything", () => {
    useAccountStore.setState({ loaded: false, onboarded: false });
    useTourStore.setState({ isOpen: true });
    render(<WelcomeTourGate />);

    expect(start).not.toHaveBeenCalled();
  });

  it("holds a replay until there is a window to point at", () => {
    workspaceMetadata.mockReturnValue({ data: { workspaces: [] } });
    useTourStore.setState({ isOpen: true });
    render(<WelcomeTourGate />);

    expect(start).not.toHaveBeenCalled();
  });
});
