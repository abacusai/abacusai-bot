/**
 * Renaming a session has to reach the list the user is looking at.
 *
 * There are two: the workspace tree reads its own workspace's sessions, the
 * sidebar's Sessions section reads the flat list across every workspace. A
 * rename that patched only the first left a new chat reading "Untitled" after
 * its first message had already named it, right until something else
 * refetched, which in practice meant creating another chat.
 */
import { QueryClient } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentMode } from "../../shared/agent-types";
import { workspaceQueryKeys } from "../lib/query-keys";
import { useWorkspaceStore } from "../stores/code-store";
import { useWorkspaceRefresh } from "./use-workspace-refresh";

type Listener = (event: Record<string, unknown>) => void;

const listeners: Listener[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  listeners.length = 0;
  (window as unknown as { api: unknown }).api = {
    agent: {
      onEvent: (listener: Listener) => {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
    },
  };
});

const seeded = (): QueryClient => {
  const client = new QueryClient();
  const sessions = [
    { id: "chat-1", label: "Untitled" },
    { id: "chat-2", label: "Another" },
  ];
  client.setQueryData(workspaceQueryKeys.agentSessions("ws-1"), [...sessions]);
  client.setQueryData(workspaceQueryKeys.allAgentSessions, [...sessions]);
  return client;
};

const renamed = (
  client: QueryClient,
  key: readonly unknown[]
): string | undefined =>
  (
    client.getQueryData(key) as { id: string; label: string }[] | undefined
  )?.find((s) => s.id === "chat-1")?.label;

describe("a session being renamed", () => {
  it("shows the new name in both lists at once", () => {
    const client = seeded();
    renderHook(() => useWorkspaceRefresh(client));

    for (const listener of listeners)
      listener({
        type: "local-cli-session-updated",
        workspaceId: "ws-1",
        sessionId: "chat-1",
        label: "check the logs",
      });

    expect(renamed(client, workspaceQueryKeys.agentSessions("ws-1"))).toBe(
      "check the logs"
    );
    // The one the sidebar actually reads.
    expect(renamed(client, workspaceQueryKeys.allAgentSessions)).toBe(
      "check the logs"
    );
  });

  it("leaves the other sessions alone", () => {
    const client = seeded();
    renderHook(() => useWorkspaceRefresh(client));

    for (const listener of listeners)
      listener({
        type: "local-cli-session-updated",
        workspaceId: "ws-1",
        sessionId: "chat-1",
        label: "check the logs",
      });

    const all = client.getQueryData(workspaceQueryKeys.allAgentSessions) as {
      id: string;
      label: string;
    }[];
    expect(all.find((s) => s.id === "chat-2")?.label).toBe("Another");
  });
});

/** One `mode_changed` off the agent stream, the way the app receives it. */
const modeChanged = (mode: AgentMode, source: string): void => {
  for (const listener of listeners)
    listener({
      type: "local-cli-ndjson",
      workspaceId: "ws-1",
      sessionId: "chat-1",
      payload: { type: "event", event: { type: "mode_changed", mode, source } },
    });
};

describe("the agent reporting its permission mode", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ globalSelectedMode: AgentMode.Yolo });
  });

  it("does not let a new session's opening mode overwrite the user's pick", () => {
    // The bug: pick full access on the welcome screen, hit send, and the agent
    // that spawns announces the mode it opened in. Treating that echo as a
    // change wrote it straight back over the selection, and the picker flipped
    // to supervised between pressing send and the first token.
    renderHook(() => useWorkspaceRefresh(seeded()));

    modeChanged(AgentMode.Normal, "startup");

    expect(useWorkspaceStore.getState().globalSelectedMode).toBe(
      AgentMode.Yolo
    );
  });

  it("ignores a bot, which is pinned to full access and is not a session preference", () => {
    useWorkspaceStore.setState({ globalSelectedMode: AgentMode.Normal });
    renderHook(() => useWorkspaceRefresh(seeded()));

    modeChanged(AgentMode.Yolo, "bot");

    expect(useWorkspaceStore.getState().globalSelectedMode).toBe(
      AgentMode.Normal
    );
  });

  it("follows the agent when an approval moved it", () => {
    // "Always allow" and leaving plan mode happen in the transcript, so the
    // picker has to catch up or it reports a mode that is no longer in force.
    useWorkspaceStore.setState({ globalSelectedMode: AgentMode.PlanMode });
    renderHook(() => useWorkspaceRefresh(seeded()));

    modeChanged(AgentMode.AcceptEdits, "approval");

    expect(useWorkspaceStore.getState().globalSelectedMode).toBe(
      AgentMode.AcceptEdits
    );
  });
});

describe("the agent giving itself a browser", () => {
  const materialized = (conversationKey: string) => {
    for (const listener of listeners)
      listener({
        type: "browser-runtime-materialized",
        conversationKey,
        resourceId: "agent-browser",
        url: "https://example.com",
      });
  };

  it("opens that chat's pane on the browser when the chat is on screen", async () => {
    const { rightPanelScopeKey, createRightPanelState } =
      await import("../stores/right-panel-store");
    const { rightPanelStore } = await import("../stores/right-panel-react");
    const { setActiveConversationKey } =
      await import("../stores/active-conversation-store");
    rightPanelStore.setState(() => createRightPanelState());
    const scope = rightPanelScopeKey({
      workspaceId: "ws-1",
      sessionId: "chat-1",
    });
    setActiveConversationKey(scope);
    renderHook(() => useWorkspaceRefresh(seeded()));

    materialized(scope);

    expect(rightPanelStore.state.scopes[scope]?.activeId).toBe(
      "browser:agent-browser"
    );
  });

  it("only marks a chat that is not on screen", async () => {
    const { rightPanelScopeKey } = await import("../stores/right-panel-store");
    const { rightPanelStore } = await import("../stores/right-panel-react");
    const { setActiveConversationKey } =
      await import("../stores/active-conversation-store");
    const { useWorkspaceStore } = await import("../stores/code-store");
    const scope = rightPanelScopeKey({
      workspaceId: "ws-1",
      sessionId: "chat-2",
    });
    setActiveConversationKey(
      rightPanelScopeKey({ workspaceId: "ws-1", sessionId: "chat-1" })
    );
    renderHook(() => useWorkspaceRefresh(seeded()));

    materialized(scope);

    expect(rightPanelStore.state.scopes[scope]?.activeId ?? null).toBeNull();
    expect(
      useWorkspaceStore.getState().isSessionCompletedInBackground("chat-2")
    ).toBe(true);
  });
});

describe("the agent navigating its browser", () => {
  it("shows the agent's own browser rather than a second view at the URL", async () => {
    const { rightPanelScopeKey, createRightPanelState } =
      await import("../stores/right-panel-store");
    const { rightPanelStore } = await import("../stores/right-panel-react");
    const { setActiveConversationKey } =
      await import("../stores/active-conversation-store");
    const { browserResourceActions, browserResourceStore } =
      await import("../stores/browser-resource-store");
    const { previewActions, previewStore, selectPreviewScope } =
      await import("../stores/preview-store");
    rightPanelStore.setState(() => createRightPanelState());
    previewActions.reset();
    const scope = rightPanelScopeKey({
      workspaceId: "ws-1",
      sessionId: "chat-1",
    });
    setActiveConversationKey(scope);
    browserResourceActions.adopt(
      scope,
      "agent-browser",
      "https://www.google.com/travel/flights"
    );
    renderHook(() => useWorkspaceRefresh(seeded()));

    for (const listener of listeners)
      listener({
        type: "mcp-open-preview",
        conversationKey: scope,
        url: "https://www.google.com/travel/flights",
      });

    expect(rightPanelStore.state.scopes[scope]?.activeId).toBe(
      "browser:agent-browser"
    );
    // No URL preview, so the panel mints no second browser.
    expect(selectPreviewScope(previewStore.state, scope).items).toEqual([]);
    expect(browserResourceStore.state.scopes[scope]?.resourceIds).toEqual([
      "agent-browser",
    ]);
  });
});
