/**
 * The sidebar's second section.
 *
 * What is pinned here is the pair's shape: two lists that read the same, and
 * the one thing that is not allowed to differ — a bot's chats are sessions
 * too, and listing them in both puts the same conversation on screen twice
 * under two different names.
 */
import { render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const activate = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const pathname = vi.hoisted(() => ({ current: "/" }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("./workspace-activation", () => ({
  useConversationActivator: () => activate,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: pathname.current } }),
}));

const sessions = vi.hoisted(() => ({
  current: [] as {
    id: string;
    workspaceId: string;
    label: string;
    updatedAt: string;
    routineId?: string | null;
    editorFor?: string | null;
  }[],
}));
const botSessionIds = vi.hoisted(() => ({
  current: new Set<string>(),
}));

vi.mock("../../hooks/use-workspace-queries", () => ({
  useAllAgentSessionsQuery: () => ({
    data: sessions.current,
    refetch: vi.fn(),
  }),
  useWorkspaceMetadataQuery: () => ({
    data: { workspaces: [{ id: "w1", label: "checkout-api" }] },
  }),
}));

vi.mock("../../hooks/use-bots", () => ({
  useBotOwnedSessionIds: () => botSessionIds.current,
}));

const { SessionsTree } = await import("./sessions-tree");
const { SidebarProvider } = await import("../ui/sidebar");
const { useSidebarAccordion } =
  await import("../../stores/sidebar-accordion-store");

/** SidebarMenuButton reads the collapsed state off the provider's context. */
const renderTree = () =>
  render(
    (
      <SidebarProvider>
        <SessionsTree />
      </SidebarProvider>
    ) as JSX.Element
  );

const byId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-id="${id}"]`);

const session = (id: string, updatedAt: string) => ({
  id,
  workspaceId: "w1",
  label: `session ${id}`,
  updatedAt,
});

beforeEach(() => {
  pathname.current = "/";
  // The accordion remembers which section is open; each test starts with
  // this one open, whatever the last one folded.
  useSidebarAccordion.setState({ openSection: "sessions" });
});

describe("the sessions section", () => {
  it("leaves every chat a bot owns to the bots section", async () => {
    sessions.current = [
      session("plain", "2026-08-27T10:00:00Z"),
      session("botchat", "2026-08-27T11:00:00Z"),
      // A routine's chat and a sender's are sessions too, and neither is on
      // `bot.sessionId` — filtering that field alone listed them here as well.
      session("routine", "2026-08-27T12:00:00Z"),
      session("sender", "2026-08-27T13:00:00Z"),
    ];
    botSessionIds.current = new Set(["botchat", "routine", "sender"]);

    renderTree();

    await waitFor(() => expect(byId("session-item-plain")).toBeTruthy());
    expect(byId("session-item-botchat")).toBeNull();
    expect(byId("session-item-routine")).toBeNull();
    expect(byId("session-item-sender")).toBeNull();
  });

  it("leaves a routine's runs and its editor to the Routines section", async () => {
    sessions.current = [
      session("plain", "2026-08-27T10:00:00Z"),
      { ...session("run", "2026-08-27T11:00:00Z"), routineId: "job-1" },
      { ...session("editor", "2026-08-27T12:00:00Z"), editorFor: "job-1" },
    ];
    botSessionIds.current = new Set();

    renderTree();

    await waitFor(() => expect(byId("session-item-plain")).toBeTruthy());
    expect(byId("session-item-run")).toBeNull();
    expect(byId("session-item-editor")).toBeNull();
  });

  it("puts the most recent first, across every workspace", async () => {
    sessions.current = [
      session("older", "2026-08-20T10:00:00Z"),
      session("newer", "2026-08-27T10:00:00Z"),
    ];
    botSessionIds.current = new Set();

    renderTree();

    await waitFor(() => expect(byId("session-item-newer")).toBeTruthy());
    const rows = [...document.querySelectorAll('[data-id^="session-item-"]')];
    expect(rows.map((row) => row.getAttribute("data-id"))).toEqual([
      "session-item-newer",
      "session-item-older",
    ]);
  });

  it("folds away without losing the + that fills it", async () => {
    sessions.current = [session("one", "2026-08-27T10:00:00Z")];
    botSessionIds.current = new Set();

    renderTree();

    await waitFor(() => expect(byId("session-item-one")).toBeTruthy());
    byId("sessions-section-toggle")!.click();

    await waitFor(() => expect(byId("session-item-one")).toBeNull());
    // The + is the section's, not the list's: a folded section you cannot add
    // to is a section you have to unfold before you can use it.
    expect(byId("new-session-btn")).toBeTruthy();
  });

  it("selects the session named by the route", async () => {
    sessions.current = [
      session("older", "2026-08-20T10:00:00Z"),
      session("newer", "2026-08-27T10:00:00Z"),
    ];
    botSessionIds.current = new Set();
    pathname.current = "/sessions/newer";

    renderTree();

    await waitFor(() => expect(byId("session-item-newer")).toBeTruthy());
    expect(byId("session-item-newer")?.hasAttribute("data-active")).toBe(true);
    expect(byId("session-item-older")?.hasAttribute("data-active")).toBe(false);
  });
});

describe("the sessions +", () => {
  it("leaves whatever pane is on screen, workspace or not", async () => {
    // Pressing + from artifacts or notifications used to do nothing visible:
    // the activator navigates only when it activated something, and with no
    // workspace there is nothing to activate — so you sat on the old page.
    sessions.current = [];
    botSessionIds.current = new Set();
    navigate.mockClear();

    renderTree();

    await waitFor(() => expect(byId("new-session-btn")).toBeTruthy());
    byId("new-session-btn")!.click();

    expect(navigate).toHaveBeenCalledWith({ to: "/sessions/new" });
  });
});

/**
 * The list is dated the way DeepAgent's chat list is: the freshest rows carry
 * no header at all, and only past them do the day labels appear. And the
 * section is its own scroller — the long list scrolls inside the sidebar,
 * not the sidebar around it.
 */
describe("how the sessions list is dated", () => {
  const daysAgo = (n: number): string =>
    new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

  it("shows no date header over the first ten rows", async () => {
    sessions.current = Array.from({ length: 8 }, (_, i) =>
      session(`s${i}`, daysAgo(i))
    );
    botSessionIds.current = new Set();

    renderTree();

    await waitFor(() => expect(byId("session-item-s0")).toBeTruthy());
    expect(document.querySelector('[data-id^="sessions-date-"]')).toBeNull();
  });

  it("labels the days once the list runs past the first ten", async () => {
    sessions.current = [
      ...Array.from({ length: 11 }, (_, i) => session(`t${i}`, daysAgo(0))),
      session("y", daysAgo(1)),
      session("old", daysAgo(3)),
    ];
    botSessionIds.current = new Set();

    renderTree();

    await waitFor(() => expect(byId("session-item-old")).toBeTruthy());
    expect(byId("sessions-date-today")).toBeNull();
    expect(byId("sessions-date-yesterday")?.textContent).toBe(
      "sessions.yesterday"
    );
    expect(byId("sessions-date-days-3")?.textContent).toBe("sessions.daysAgo");
  });

  it("scrolls inside its own section", async () => {
    sessions.current = [session("one", daysAgo(0))];
    botSessionIds.current = new Set();

    renderTree();

    await waitFor(() => expect(byId("session-item-one")).toBeTruthy());
    const scroller = byId("sessions-scroller");
    expect(scroller?.hasAttribute("data-sidebar-scroller")).toBe(true);
    expect(scroller?.className).toContain("overflow-y-auto");
  });
});
