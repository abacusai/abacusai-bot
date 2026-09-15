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
vi.mock("../../hooks/use-abacus-account", () => ({
  useAbacusAccountQuery: () => abacusAccount(),
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

const { WelcomeTour, WelcomeTourGate } = await import("./welcome-tour");
const { TourTooltip } = await import("./tour-tooltip");
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
    // SpotlightTour re-registers when `steps` changes identity, and the
    // cleanup stops the running tour.
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
    // The bots tree is always rendered, whichever list the sidebar shows.
    expect(steps[0]?.target).toBe('[data-id="sidebar-lists"]');
    // Nothing leaves the workspace shell; the bot-maker stop navigates itself.
    expect(new Set(steps.map((step) => step.route))).toEqual(
      new Set(["/", undefined])
    );
  });

  it("spotlights nothing the window does not render", async () => {
    // Tourlight waits two seconds for a missing target before skipping the
    // stop, so a target only some layouts render hangs the lap.
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

    expect(step?.title).toBe("tour.steps.makeBot.title");
    expect(step?.content).toBe("tour.steps.makeBot.body");
  });

  it("puts the bot maker on screen rather than hoping for it", async () => {
    render(<WelcomeTour />);
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith("workspace-onboarding")
    );

    const step = (tourProps.current?.steps ?? [])[1];

    expect(step?.target).toBe('[data-id="bots-home-name-input"]');
    // No route: a second navigation between the stop's wait for the field
    // and Tourlight's measurement would remount the pane.
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
      '[data-id="bots-home-name-input"]',
      '[data-id="sidebar-nav-connectors"]',
      '[data-id="local-code-bottom-panel-toggle"]',
    ]);
    // Nothing on a settings page: the lap must not end there.
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
    // Tourlight re-registers when a callback prop changes identity, and the
    // cleanup stops the running tour; the flow passes `onFinish` inline.
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
 * Nothing but an explicit `open()` may start a tour: localStorage clears on a
 * userData move, and a flag whose absence starts a lap replays it for
 * existing users. Every case is an onboarded user.
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
});
