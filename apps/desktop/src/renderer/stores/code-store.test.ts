/**
 * The permission mode a fresh install runs in, and what a stored choice does
 * to it. Behaviour, not trivia: the default decides whether the agent stops
 * before touching the machine, and a stored pick has to survive a launch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentMode } from "#shared/agent-types";

const STORE_KEY = "local-code-ui-store";

/**
 * Persisted state is read at import time, so each case needs the module
 * evaluated again against its own storage rather than the last case's.
 */
const loadStore = async () => {
  vi.resetModules();
  const module = await import("./code-store");
  await module.useWorkspaceStore.persist.rehydrate();
  return module.useWorkspaceStore;
};

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("workspace ui store", () => {
  it("runs with full access by default", async () => {
    const useWorkspaceStore = await loadStore();
    expect(useWorkspaceStore.getState().globalSelectedMode).toBe(
      AgentMode.Yolo
    );
  });

  it("keeps a stored full-access pick rather than resetting it", async () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        version: 1,
        state: { globalSelectedMode: AgentMode.Yolo },
      })
    );

    const useWorkspaceStore = await loadStore();

    expect(useWorkspaceStore.getState().globalSelectedMode).toBe(
      AgentMode.Yolo
    );
  });

  it("keeps a stored choice that is not the default", async () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ state: { globalSelectedMode: AgentMode.PlanMode } })
    );

    const useWorkspaceStore = await loadStore();

    expect(useWorkspaceStore.getState().globalSelectedMode).toBe(
      AgentMode.PlanMode
    );
  });

  it("drops a stored per-workspace mode rather than promoting it", async () => {
    // The per-workspace value is the one that used to win over whatever the
    // picker was showing, which is how a mode chosen on the welcome screen
    // (where no workspace is selected) was lost on send. It is not carried
    // forward: the global is the sticky value for every session.
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        version: 3,
        state: {
          globalSelectedMode: AgentMode.AcceptEdits,
          workspaceSelectedModes: { w1: AgentMode.Yolo },
        },
      })
    );

    const useWorkspaceStore = await loadStore();

    expect(useWorkspaceStore.getState().getSelectedMode()).toBe(
      AgentMode.AcceptEdits
    );
    expect(
      (useWorkspaceStore.getState() as Record<string, unknown>)
        .workspaceSelectedModes
    ).toBeUndefined();
  });

  it("activates a workspace and session in one synchronous store transition", async () => {
    const useWorkspaceStore = await loadStore();
    useWorkspaceStore.setState({
      activeWorkspaceId: "workspace-one",
      sessionWorkspaceMap: { "session-two": "workspace-two" },
      backgroundCompletedSessionIds: ["session-two"],
    });
    let notifications = 0;
    const unsubscribe = useWorkspaceStore.subscribe(() => {
      notifications += 1;
    });

    const activated = useWorkspaceStore
      .getState()
      .activateWorkspaceSession("workspace-two", "session-two");

    unsubscribe();
    const state = useWorkspaceStore.getState();
    expect(activated).toBe(true);
    expect(notifications).toBe(1);
    expect(state.activeWorkspaceId).toBe("workspace-two");
    expect(state.workspaceUiStates["workspace-two"]?.activeSessionId).toBe(
      "session-two"
    );
    expect(state.backgroundCompletedSessionIds).toEqual([]);
  });

  it("starts a clean draft when a workspace is activated without a session", async () => {
    const useWorkspaceStore = await loadStore();
    useWorkspaceStore.setState({
      activeWorkspaceId: "workspace-one",
      workspaceUiStates: {
        "workspace-two": { activeSessionId: "previous-session" },
      },
    });

    useWorkspaceStore
      .getState()
      .activateWorkspaceSession("workspace-two", null);

    const state = useWorkspaceStore.getState();
    expect(state.activeWorkspaceId).toBe("workspace-two");
    expect(
      state.workspaceUiStates["workspace-two"]?.activeSessionId
    ).toBeNull();
  });

  it("refuses to cross-wire a session into another workspace", async () => {
    const useWorkspaceStore = await loadStore();
    useWorkspaceStore.setState({
      activeWorkspaceId: "workspace-one",
      sessionWorkspaceMap: { session: "workspace-one" },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const activated = useWorkspaceStore
      .getState()
      .activateWorkspaceSession("workspace-two", "session");

    expect(activated).toBe(false);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(
      "workspace-one"
    );
    expect(
      useWorkspaceStore.getState().workspaceUiStates["workspace-two"]
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("a deselected workspace", () => {
  it("stays deselected through a metadata refresh, with no chat pinned", async () => {
    const store = await loadStore();
    store.getState().activateWorkspaceSession("w1", "s1");
    store.getState().deselectWorkspace();

    store.getState().hydrateActiveWorkspaceFromMetadata("w1", ["w1"]);

    expect(store.getState().activeWorkspaceId).toBeNull();
    expect(store.getState().workspaceUiStates.w1?.activeSessionId).toBeNull();
  });

  it("still takes main's workspace on the very first hydration", async () => {
    const store = await loadStore();

    store.getState().hydrateActiveWorkspaceFromMetadata("w1", ["w1"]);

    expect(store.getState().activeWorkspaceId).toBe("w1");
  });

  it("is over once a workspace is activated again", async () => {
    const store = await loadStore();
    store.getState().deselectWorkspace();
    store.getState().activateWorkspaceSession("w2", null);
    store.getState().deselectWorkspace();
    store.getState().activateWorkspaceSession("w2", "s2");

    expect(store.getState().workspaceDeselected).toBe(false);
    expect(store.getState().workspaceUiStates.w2?.activeSessionId).toBe("s2");
  });

  it("stops restoring an app-wide right pane, which belongs to the conversation", async () => {
    // A v2 install persisted whichever chat last opened its pane; restoring it
    // on launch put one chat's preview over another. v3 drops both fields.
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        version: 2,
        state: { isRightPanelVisible: true, activeRightTab: "preview" },
      })
    );

    const useWorkspaceStore = await loadStore();

    expect(useWorkspaceStore.getState().isRightPanelVisible).toBe(false);
    expect(useWorkspaceStore.getState().activeRightTab).toBeNull();

    useWorkspaceStore.getState().setRightPanelVisible(true);
    useWorkspaceStore.getState().setActiveRightTab("preview");
    const persisted = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as {
      state: Record<string, unknown>;
    };
    expect(persisted.state).not.toHaveProperty("isRightPanelVisible");
    expect(persisted.state).not.toHaveProperty("activeRightTab");
  });
});

describe("the last picked workspace", () => {
  it("survives a reload, so a new session can open on it", async () => {
    const store = await loadStore();
    store.getState().setLastPickedWorkspaceId("w1");

    const reloaded = await loadStore();

    expect(reloaded.getState().lastPickedWorkspaceId).toBe("w1");
  });
});
