import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
const activateWorkspaceSession = vi.fn(() => true);
const storeState = {
  activeWorkspaceId: "workspace-one",
  activateWorkspaceSession,
};

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../../stores/code-store", () => ({
  useWorkspaceStore: Object.assign(
    <Value,>(selector: (state: typeof storeState) => Value): Value =>
      selector(storeState),
    { getState: () => storeState }
  ),
}));

const { activateWorkspaceConversation, useConversationActivator } =
  await import("./workspace-activation");

describe("activateWorkspaceConversation", () => {
  it("returns after the optimistic activation without waiting for IPC", () => {
    const order: string[] = [];
    const neverResolvingIpc = new Promise<unknown>(() => {});
    const acknowledge = vi.fn(() => {
      order.push("ipc");
      return neverResolvingIpc;
    });

    const result = activateWorkspaceConversation({
      target: {
        workspaceId: "workspace-two",
        sessionId: "session-two",
      },
      currentWorkspaceId: "workspace-one",
      activate: () => {
        order.push("paint");
        return true;
      },
      acknowledge,
    });

    expect(result).toBe(true);
    expect(order).toEqual(["paint", "ipc"]);
    expect(acknowledge).toHaveBeenCalledWith("workspace-two");
  });

  it("does not reconcile or invalidate anything for an in-workspace chat switch", () => {
    const acknowledge = vi.fn(async () => undefined);

    const result = activateWorkspaceConversation({
      target: {
        workspaceId: "workspace-one",
        sessionId: "another-session",
      },
      currentWorkspaceId: "workspace-one",
      activate: () => true,
      acknowledge,
    });

    expect(result).toBe(true);
    expect(acknowledge).not.toHaveBeenCalled();
  });
});

describe("useConversationActivator", () => {
  beforeEach(() => {
    navigate.mockClear();
    activateWorkspaceSession.mockClear();
    activateWorkspaceSession.mockReturnValue(true);
    window.api = {
      agent: { switchWorkspace: vi.fn(async () => undefined) },
    } as unknown as typeof window.api;
  });

  it("leaves the open pane for the chat the session lives in", () => {
    const { result } = renderHook(() => useConversationActivator());

    expect(
      result.current({ workspaceId: "workspace-two", sessionId: "session-two" })
    ).toBe(true);
    expect(activateWorkspaceSession).toHaveBeenCalledWith(
      "workspace-two",
      "session-two"
    );
    // Without this the transcript switches behind whichever pane destination is
    // showing and the click reads as dead.
    expect(navigate).toHaveBeenCalledWith({
      to: "/sessions/$sessionId",
      params: { sessionId: "session-two" },
    });
  });

  it("stays put when the store refuses the activation", () => {
    activateWorkspaceSession.mockReturnValue(false);
    const { result } = renderHook(() => useConversationActivator());

    expect(
      result.current({ workspaceId: "workspace-two", sessionId: "foreign" })
    ).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
