/**
 * A routine's page: the run on screen follows the rail, the composer talks
 * to the routine, and an auto-reply chat gets the grant controls instead.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
const activateWorkspaceSession = vi.fn();
const markSessionViewed = vi.fn();
const routines = vi.hoisted(() => ({
  current: [] as Record<string, unknown>[],
}));
const runs = vi.hoisted(() => ({ current: [] as Record<string, unknown>[] }));
const senderChats = vi.hoisted(() => ({
  current: [] as Record<string, unknown>[],
}));
const editRoutineByChat = vi.fn(async () => "Now every day at 9:00 AM.");
const decideMessagingPairing = vi.fn(async () => ({}));

vi.mock("react-i18next", () => {
  const t = (key: string, values?: Record<string, string>): string =>
    values == null ? key : `${key} ${JSON.stringify(values)}`;
  const translation = { t, i18n: { language: "en-US" } };
  return { useTranslation: () => translation };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../chat/chat-panel", () => ({
  ChatPanel: () => <div data-id="chat-panel-stub" />,
}));
vi.mock("../settings/routines-panel", () => ({
  describeSchedule: () => "Daily at 9:00 AM",
  RoutineDialog: () => null,
}));
vi.mock("../../hooks/use-routines", () => ({
  useRoutinesQuery: () => ({ data: routines.current, isPending: false }),
  useRoutineRunsQuery: () => ({ data: runs.current }),
  useRunRoutineMutation: () => ({ mutateAsync: vi.fn(async () => {}) }),
  useUpdateRoutineMutation: () => ({ mutateAsync: vi.fn(async () => {}) }),
  useRemoveRoutineMutation: () => ({ mutateAsync: vi.fn(async () => {}) }),
}));
vi.mock("../../hooks/use-bots", () => ({
  useBotSenderChatsQuery: () => ({
    data: senderChats.current,
    isPending: false,
  }),
  useBotsQuery: () => ({ data: [{ id: "bot-1", name: "Scout" }] }),
}));
vi.mock("../../stores/code-store", () => ({
  useWorkspaceStore: {
    getState: () => ({
      activeWorkspaceId: "w",
      activateWorkspaceSession,
      markSessionViewed,
    }),
  },
}));

const { RoutinePage } = await import("./routine-page");

const byId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-id="${id}"]`);

const mount = (routineId: string): void => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    (
      <QueryClientProvider client={client}>
        <RoutinePage routineId={routineId} />
      </QueryClientProvider>
    ) as JSX.Element
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis.window as unknown as { api: unknown }).api = {
    agent: {
      editRoutineByChat,
      decideMessagingPairing,
      switchWorkspace: vi.fn(),
    },
  };
  routines.current = [
    {
      id: "job-1",
      name: "Unread Gmail alert",
      schedule: "0 9 * * *",
      runAt: null,
      prompt: "Check unread mail.",
      enabled: true,
      botName: null,
      nextRunAt: null,
    },
  ];
  runs.current = [
    {
      sessionId: "run-new",
      workspaceId: "w",
      startedAt: "2026-09-03T09:00:00Z",
      updatedAt: "2026-09-03T09:01:00Z",
      outcome: "running",
      trigger: "schedule",
    },
    {
      sessionId: "run-old",
      workspaceId: "w",
      startedAt: "2026-09-02T09:00:00Z",
      updatedAt: "2026-09-02T09:01:00Z",
      outcome: "failed",
      trigger: "manual",
    },
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
  ];
});

describe("a scheduled routine's page", () => {
  it("shows the newest run and lists every run in the rail", async () => {
    mount("job-1");

    await waitFor(() => expect(byId("routine-page-job-1")).toBeTruthy());
    expect(byId("routine-page-name")?.textContent).toBe("Unread Gmail alert");
    expect(activateWorkspaceSession).toHaveBeenCalledWith("w", "run-new");
    expect(byId("routine-run-run-new")?.getAttribute("aria-pressed")).toBe(
      "true"
    );
    expect(byId("routine-run-run-old")).toBeTruthy();
    expect(byId("chat-panel-stub")).toBeTruthy();
  });

  it("puts a picked run on screen", async () => {
    mount("job-1");
    await waitFor(() => expect(byId("routine-run-run-old")).toBeTruthy());

    fireEvent.click(byId("routine-run-run-old")!);

    await waitFor(() =>
      expect(activateWorkspaceSession).toHaveBeenLastCalledWith("w", "run-old")
    );
  });

  it("shows the prompt and no chat when nothing has fired yet", async () => {
    runs.current = [];
    mount("job-1");

    await waitFor(() => expect(byId("routine-page-empty")).toBeTruthy());
    expect(byId("chat-panel-stub")).toBeNull();
    expect(byId("routine-page-empty")?.textContent).toContain(
      "Check unread mail."
    );
  });

  it("sends the composer's words to the routine and shows its answer", async () => {
    mount("job-1");
    await waitFor(() => expect(byId("routine-editor-input")).toBeTruthy());

    fireEvent.change(byId("routine-editor-input")!, {
      target: { value: "every morning at 9 instead" },
    });
    fireEvent.keyDown(byId("routine-editor-input")!, { key: "Enter" });

    await waitFor(() =>
      expect(editRoutineByChat).toHaveBeenCalledWith(
        "job-1",
        "every morning at 9 instead"
      )
    );
    await waitFor(() =>
      expect(byId("routine-editor-reply")?.textContent).toBe(
        "Now every day at 9:00 AM."
      )
    );
    expect((byId("routine-editor-input") as HTMLInputElement).value).toBe("");
  });
});

describe("an auto-reply chat's page", () => {
  it("shows the conversation with the grant controls, and no composer", async () => {
    mount("chat:s-ravi");

    await waitFor(() => expect(byId("auto-reply-page-s-ravi")).toBeTruthy());
    expect(activateWorkspaceSession).toHaveBeenCalledWith("w", "s-ravi");
    expect(byId("chat-panel-stub")).toBeTruthy();
    expect(byId("routine-editor")).toBeNull();
    expect(byId("routine-runs-rail")).toBeNull();

    fireEvent.click(byId("auto-reply-page-toggle")!);
    await waitFor(() =>
      expect(decideMessagingPairing).toHaveBeenCalledWith({
        platformId: "whatsapp",
        userId: "u1",
        decision: "pause",
      })
    );
  });
});
