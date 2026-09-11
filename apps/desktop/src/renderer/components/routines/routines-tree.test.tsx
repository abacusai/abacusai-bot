/**
 * The Routines section: scheduled routines and the chats a bot answers on
 * its own, one list, each opening its own page.
 */
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
const pathname = vi.hoisted(() => ({ current: "/" }));
const routines = vi.hoisted(() => ({
  current: [] as Record<string, unknown>[],
}));
const senderChats = vi.hoisted(() => ({
  current: [] as Record<string, unknown>[],
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: pathname.current } }),
}));
vi.mock("../../hooks/use-routines", () => ({
  useRoutinesQuery: () => ({ data: routines.current }),
  useRoutinesEventSync: () => {},
}));
vi.mock("../../hooks/use-bots", () => ({
  useBotSenderChatsQuery: () => ({ data: senderChats.current }),
  useBotsQuery: () => ({ data: [{ id: "bot-1", name: "Scout" }] }),
}));
vi.mock("../../hooks/use-workspace-queries", () => ({
  useSessionTurnStateQuery: () => ({ data: { isBusy: false } }),
}));

const { RoutinesTree } = await import("./routines-tree");
const { useSidebarAccordion } =
  await import("../../stores/sidebar-accordion-store");
const { SidebarProvider } = await import("../ui/sidebar");

const byId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-id="${id}"]`);

const mount = (): void => {
  render(
    (
      <SidebarProvider>
        <RoutinesTree />
      </SidebarProvider>
    ) as JSX.Element
  );
};

beforeEach(() => {
  navigate.mockClear();
  pathname.current = "/";
  // The accordion opens one section at a time; these tests look at this one.
  useSidebarAccordion.setState({ openSection: "routines" });
  routines.current = [
    { id: "job-1", name: "Unread Gmail alert", enabled: true },
    { id: "job-2", name: "Say hi", enabled: false },
  ];
  senderChats.current = [
    {
      botId: "bot-1",
      workspaceId: "w",
      sessionId: "s-ravi",
      platform: "whatsapp",
      senderName: "Ravi",
      chatId: "c1",
      userId: "u1",
      autoReply: "approved",
    },
    {
      botId: "bot-1",
      workspaceId: "w",
      sessionId: "s-stranger",
      platform: "whatsapp",
      senderName: "Stranger",
      chatId: "c2",
      userId: "u2",
      autoReply: null,
    },
  ];
});

describe("the routines section", () => {
  it("lists routines and granted auto-reply chats, and nothing else", async () => {
    mount();

    await waitFor(() => expect(byId("routine-item-job-1")).toBeTruthy());
    expect(byId("routine-item-job-2")).toBeTruthy();
    expect(byId("auto-reply-item-s-ravi")).toBeTruthy();
    // No grant, no entry: a stranger is not something that runs on its own.
    expect(byId("auto-reply-item-s-stranger")).toBeNull();
  });

  it("opens each entry on its own page", async () => {
    mount();
    await waitFor(() => expect(byId("routine-item-job-1")).toBeTruthy());

    fireEvent.click(byId("routine-item-job-1")!);
    expect(navigate).toHaveBeenCalledWith({
      to: "/routines/$routineId",
      params: { routineId: "job-1" },
    });

    fireEvent.click(byId("auto-reply-item-s-ravi")!);
    expect(navigate).toHaveBeenCalledWith({
      to: "/routines/$routineId",
      params: { routineId: "chat:s-ravi" },
    });
  });

  it("highlights the entry whose page is open", async () => {
    pathname.current = "/routines/chat:s-ravi";
    mount();
    await waitFor(() => expect(byId("auto-reply-item-s-ravi")).toBeTruthy());
    expect(byId("auto-reply-item-s-ravi")?.hasAttribute("data-active")).toBe(
      true
    );
    expect(byId("routine-item-job-1")?.hasAttribute("data-active")).toBe(false);
  });
});

/**
 * A heading that only ever says "none" is worse than no heading: the section
 * used to keep its label, its count and its disclosure arrow through an empty
 * list, with nothing to disclose.
 */
describe("with nothing running on its own", () => {
  it("shows no section at all", () => {
    routines.current = [];
    senderChats.current = [];

    mount();

    expect(byId("routines-list")).toBeNull();
    expect(byId("routines-section")).toBeNull();
    expect(byId("new-routine-sidebar-btn")).toBeNull();
  });

  it("comes back as soon as there is one", async () => {
    routines.current = [{ id: "job-1", name: "Say hi", enabled: true }];
    senderChats.current = [];

    mount();

    await waitFor(() => expect(byId("routines-list")).toBeTruthy());
    expect(byId("routine-item-job-1")).toBeTruthy();
  });

  it("counts an auto-reply chat as something running on its own", async () => {
    routines.current = [];

    mount();

    await waitFor(() => expect(byId("routines-list")).toBeTruthy());
    expect(byId("auto-reply-item-s-ravi")).toBeTruthy();
  });
});
