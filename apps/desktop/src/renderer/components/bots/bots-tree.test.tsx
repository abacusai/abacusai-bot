/**
 * The bots section is one panel of the sidebar's accordion: open, it is the
 * whole list inside its own scroller; folded, it is a header line.
 */
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: "/" } }),
}));

const bots = vi.hoisted(() => ({
  current: [] as {
    id: string;
    name: string;
    title: string;
    updatedAt: number;
    workspaceId: string | null;
    sessionId: string | null;
    avatarColor: string;
    avatarShape: string;
  }[],
}));

vi.mock("../../hooks/use-bots", () => ({
  useBotsQuery: () => ({ data: bots.current }),
  useBotChatPreviewsQuery: () => ({ data: {} }),
  useBotsEventSync: () => {},
  useDeleteBotMutation: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("../../hooks/use-workspace-queries", () => ({
  useSessionTurnStateQuery: () => ({ data: undefined }),
}));

vi.mock("./bot-dialog", () => ({ BotDialog: () => null }));

const { BotsTree } = await import("./bots-tree");
const { SidebarProvider } = await import("../ui/sidebar");
const { useSidebarAccordion } =
  await import("../../stores/sidebar-accordion-store");

const renderTree = () =>
  render(
    (
      <SidebarProvider>
        <BotsTree />
      </SidebarProvider>
    ) as JSX.Element
  );

const byId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-id="${id}"]`);
const rows = (): number =>
  document.querySelectorAll('[data-id^="bot-item-"]').length;

const bot = (id: string, updatedAt: number) => ({
  id,
  name: `bot ${id}`,
  title: "role",
  updatedAt,
  workspaceId: null,
  sessionId: null,
  avatarColor: "#22c55e",
  avatarShape: "squircle",
});

beforeEach(() => {
  useSidebarAccordion.setState({ openSection: "bots" });
});

describe("the bots section", () => {
  it("lists every bot inside its own scroller when open", async () => {
    bots.current = Array.from({ length: 12 }, (_, i) => bot(`b${i}`, 100 - i));

    renderTree();

    await waitFor(() => expect(rows()).toBe(12));
    const scroller = byId("bots-scroller");
    expect(scroller?.hasAttribute("data-sidebar-scroller")).toBe(true);
    expect(scroller?.className).toContain("overflow-y-auto");
    expect(scroller?.className).toContain("flex-1");
  });

  it("folds to its header, keeping the + that fills it", async () => {
    bots.current = [bot("a", 2), bot("b", 1)];

    renderTree();

    await waitFor(() => expect(rows()).toBe(2));
    fireEvent.click(byId("bots-section-toggle")!);

    await waitFor(() => expect(rows()).toBe(0));
    expect(byId("new-bot-btn")).toBeTruthy();
    expect(useSidebarAccordion.getState().openSection).toBeNull();
  });

  it("is folded while another section is open", async () => {
    bots.current = [bot("a", 2)];
    useSidebarAccordion.setState({ openSection: "sessions" });

    renderTree();

    await waitFor(() => expect(byId("bots-section-toggle")).toBeTruthy());
    expect(rows()).toBe(0);
    expect(byId("bots-section-toggle")?.getAttribute("aria-expanded")).toBe(
      "false"
    );
  });
});
