import type { QueryClient } from "@tanstack/react-query";
import { useEffectEvent } from "react";
import { useEffect } from "react";

import type { AgentMode } from "#shared/agent-types";
import type { IpcEvent, SessionTurnStateSnapshot } from "#shared/contracts";
import { conversationRefFromKey } from "#shared/conversation-scope";

import type { AgentLoopEvent } from "../conversation/agent-types";
import {
  forgetAgentBrowserReveal,
  revealAgentBrowser,
} from "../lib/agent-browser";
import { openPreviewTab } from "../lib/preview-tabs";
import { workspaceQueryKeys } from "../lib/query-keys";
import { getActiveConversationKey } from "../stores/active-conversation-store";
import { useAgentSessionStore } from "../stores/agent-session-store";
import { browserResourceActions } from "../stores/browser-resource-store";
import { useWorkspaceStore } from "../stores/code-store";
import { rightPanelStore } from "../stores/right-panel-react";
import { selectRightPanelScope } from "../stores/right-panel-store";
import { useSessionSkillsStore } from "../stores/session-skills-store";
import { excludeBuiltinSkills } from "../utils/skill-utils";
import type { AgentSessionEntry } from "./use-agent-session-mutations";

export const useWorkspaceRefresh = (queryClient: QueryClient): void => {
  const handleIpcEvent = useEffectEvent((event: IpcEvent) => {
    const agentSessionStore = useAgentSessionStore.getState();
    // The agent gave itself a browser: adopt it under main's id and show it
    // if that chat is on screen.
    if (event.type === "browser-runtime-materialized") {
      browserResourceActions.adopt(
        event.conversationKey,
        event.resourceId,
        event.url
      );
      // A new browser is news even in a chat whose earlier one was seen.
      forgetAgentBrowserReveal(event.conversationKey);
      // Judged by the active conversation key, which the right panel is scoped
      // by; the per-workspace active session is stale after a restart.
      if (event.conversationKey === getActiveConversationKey()) {
        revealAgentBrowser(event.conversationKey);
        return;
      }
      const ref = conversationRefFromKey(event.conversationKey);
      // A bot browsing in the background earns the same dot a background turn does.
      if (ref?.kind === "session")
        useWorkspaceStore.getState().markSessionCompleted(ref.sessionId);
      return;
    }
    if (event.type === "mcp-open-preview") {
      // Only the caller's own pane, and only when that chat is on screen: the
      // user's pane is not the agent's to take.
      const active = getActiveConversationKey();
      const scope = event.conversationKey ?? active;
      if (scope == null || scope !== active) return;
      const store = useWorkspaceStore.getState();
      store.setActiveRightTab("preview");
      store.setRightPanelVisible(true);
      // Show the agent's own browser when it has one; navigating the preview
      // to the URL would mint a second view that never follows the agent.
      if (revealAgentBrowser(scope)) return;
      // Navigate only when no browser is showing, so a webview exists for MCP.
      if (event.url) {
        const panel = selectRightPanelScope(rightPanelStore.state, scope);
        const active = panel.descriptors.find(
          ({ id }) => id === panel.activeId
        );
        const showingBrowser =
          active?.kind === "resource" && active.resourceType === "browser";
        if (!showingBrowser) {
          openPreviewTab(scope, {
            type: "url",
            location: event.url,
            title: event.url,
          });
        }
      }
      return;
    }
    if (event.type === "metadata-updated") {
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.metadata,
      });
      // Reconcile activeWorkspaceId from main only on hydration or when ours
      // points at a removed workspace; never clobber a switch mid-flight.
      void window.api.agent
        .getMetadata()
        .then((metadata) => {
          const ids = (metadata?.workspaces ?? [])
            .map((w) => w.id)
            .filter((x: unknown): x is string => typeof x === "string");
          useWorkspaceStore
            .getState()
            .hydrateActiveWorkspaceFromMetadata(
              metadata?.activeWorkspaceId ?? null,
              ids
            );
        })
        .catch(() => {});
    }
    if (event.type === "git-state-updated") {
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.gitStateRoot,
      });
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.gitCurrentBranchRoot,
      });
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.gitBranchesRoot,
      });
    }
    if (event.type === "sessions-reloaded") {
      // A sign-out or sign-in swapped the whole stash; no per-session event says so.
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.agentSessionsRoot,
      });
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.allAgentSessions,
      });
    }
    if (event.type === "file-tree-root-updated") {
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.fileTreeRootRoot,
      });
    }
    if (
      event.type === "local-cli-session-created" &&
      event.workspaceId != null &&
      event.session != null
    ) {
      // The ownership ledger lets setActiveSessionId reject cross-workspace pins.
      useWorkspaceStore
        .getState()
        .registerSessionWorkspace(event.session.id, event.workspaceId);
      queryClient.setQueryData(
        workspaceQueryKeys.agentSessions(event.workspaceId),
        (prev: AgentSessionEntry[] | undefined) => {
          // useCreateSessionMutation.onSuccess may already have prepended this
          // session, or a placeholder may still hold the slot.
          const next =
            prev != null
              ? [
                  event.session,
                  ...prev.filter(
                    (s) =>
                      s.id !== event.session.id &&
                      !(
                        typeof s.id === "string" &&
                        s.id.startsWith("placeholder-")
                      )
                  ),
                ]
              : [event.session];
          return next;
        }
      );
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.agentSessions(event.workspaceId),
      });
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.allAgentSessions,
      });
    }
    if (event.type === "local-cli-skills-loaded" && event.sessionId != null) {
      // Builtin skills are never user-picked; an empty list falls back to disk.
      useSessionSkillsStore
        .getState()
        .setSkills(event.sessionId, excludeBuiltinSkills(event.skills ?? []));
    }
    if (
      event.type === "local-cli-system-ready" &&
      event.workspaceId != null &&
      event.sessionId != null
    ) {
      // The CLI re-reads skills only at process start; ask for the list now.
      void window.api.agent.listAgentSkills({
        workspaceId: event.workspaceId,
        sessionId: event.sessionId,
      });
    }
    if (
      event.type === "local-cli-session-removed" &&
      event.workspaceId != null &&
      event.sessionId != null
    ) {
      agentSessionStore.clearSessionRuntime(event.sessionId);
      useSessionSkillsStore.getState().clearSkills(event.sessionId);
      useWorkspaceStore.getState().unregisterSession(event.sessionId);
      queryClient.setQueryData(
        workspaceQueryKeys.agentSessions(event.workspaceId),
        (prev: AgentSessionEntry[] | undefined) =>
          prev?.filter((s) => s.id !== event.sessionId) ?? []
      );
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.agentSessions(event.workspaceId),
      });
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.allAgentSessions,
      });
    }
    if (
      event.type === "local-cli-session-updated" &&
      event.workspaceId != null &&
      event.sessionId != null
    ) {
      // Both lists: the workspace tree reads its own, the Sessions section the
      // flat one. Patching only the first leaves the sidebar on "Untitled".
      const rename = (
        prev: AgentSessionEntry[] | undefined
      ): AgentSessionEntry[] =>
        prev?.map((s) =>
          s.id === event.sessionId ? { ...s, label: event.label } : s
        ) ?? [];

      queryClient.setQueryData(
        workspaceQueryKeys.agentSessions(event.workspaceId),
        rename
      );
      queryClient.setQueryData(workspaceQueryKeys.allAgentSessions, rename);
    }
    if (
      event.type === "local-cli-session-model-updated" &&
      event.workspaceId != null &&
      event.sessionId != null
    ) {
      // The panel reopens a session on the model listed here.
      queryClient.setQueryData(
        workspaceQueryKeys.agentSessions(event.workspaceId),
        (prev: AgentSessionEntry[] | undefined) =>
          prev?.map((s) =>
            s.id === event.sessionId ? { ...s, model: event.model } : s
          ) ?? []
      );
    }
    if (
      event.type === "local-cli-session-conversation-id-updated" &&
      event.workspaceId != null &&
      event.sessionId != null
    ) {
      queryClient.setQueryData(
        workspaceQueryKeys.agentSessions(event.workspaceId),
        (prev: AgentSessionEntry[] | undefined) =>
          prev?.map((s) =>
            s.id === event.sessionId
              ? { ...s, conversationId: event.conversationId }
              : s
          ) ?? []
      );
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.allAgentSessions,
      });
    }
    if (
      event.type === "local-cli-state-updated" &&
      event.workspaceId != null &&
      event.sessionId != null &&
      event.state != null
    ) {
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.cliSessionState(
          event.workspaceId,
          event.sessionId
        ),
      });
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.agentRuns(),
      });
      // Main should emit session-turn-state-updated too, but if that event was
      // lost (window recreated, IPC failure) this stops the spinner.
      if (event.state.status === "stopped" || event.state.status === "error") {
        const idle: SessionTurnStateSnapshot = {
          sessionId: event.sessionId,
          workspaceId: event.workspaceId,
          phase: "idle",
          isBusy: false,
          updatedAt: new Date().toISOString(),
        };
        queryClient.setQueryData(
          workspaceQueryKeys.sessionTurnState(event.sessionId),
          idle
        );
      }
    }
    if (event.type === "session-artifacts-updated") {
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.sessionArtifacts,
      });
    }
    if (
      event.type === "session-turn-state-updated" &&
      event.sessionId != null &&
      event.state != null
    ) {
      // Authoritative; written straight to the cache, no refetch.
      queryClient.setQueryData(
        workspaceQueryKeys.sessionTurnState(event.sessionId),
        event.state
      );
    }
    if (
      event.type === "local-cli-system-ready" &&
      event.workspaceId != null &&
      event.sessionId != null
    ) {
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.cliSessionState(
          event.workspaceId,
          event.sessionId
        ),
      });
    }
    // The transcript is fed by the NDJSON bridge (conversation/store.tsx); this
    // branch only handles consequences outside it: mode sync and git refresh.
    if (
      event.type === "local-cli-ndjson" &&
      event.workspaceId != null &&
      event.sessionId != null
    ) {
      const message = event.payload as {
        type?: string;
        event?: AgentLoopEvent;
      } | null;
      if (message == null || message.type !== "event" || message.event == null)
        return;
      const agentEvent = message.event;
      // Follow the agent only when it moved itself (an "always allow" mid-turn).
      // Never "startup": that echoes the mode the spawn was handed and would
      // overwrite the user's pick, and a bot's pinned full access would leak
      // into every later session. "user" came from the UI, which already has it.
      // `source` is on our wire event but not on the vendored upstream type.
      const modeSource =
        agentEvent.type === "mode_changed"
          ? (agentEvent as { source?: string }).source
          : undefined;
      if (agentEvent.type === "mode_changed" && modeSource === "approval") {
        const store = useWorkspaceStore.getState();
        if (store.globalSelectedMode !== agentEvent.mode) {
          store.setSelectedMode(agentEvent.mode as AgentMode);
        }
      }
      if (agentEvent.type === "turn_complete") {
        const store = useWorkspaceStore.getState();
        const activeSessionId = store.getActiveSessionId(event.workspaceId);
        if (event.sessionId !== activeSessionId) {
          store.markSessionCompleted(event.sessionId);
        }
        // The turn just spent credits; the account is stale by exactly that
        // much. Past main's cache, or the read returns what it already had.
        if ((agentEvent as { usage?: unknown }).usage != null) {
          void window.api.agent.getAbacusAccount(true).then((fresh) => {
            if (fresh != null)
              queryClient.setQueryData(workspaceQueryKeys.abacusAccount, fresh);
          });
        }
      }
      // Refresh git state on a file-mutating tool rather than waiting for the
      // main-side watcher to fire `git-state-updated`.
      if (agentEvent.type === "tool_result") {
        const toolName = agentEvent.toolCall.name;
        const mutatesFile =
          toolName === "edit" ||
          toolName === "batch_edit" ||
          toolName === "notebook_edit" ||
          toolName === "write" ||
          toolName === "delete";
        if (mutatesFile) {
          void queryClient.invalidateQueries({
            queryKey: workspaceQueryKeys.gitStateRoot,
          });
          void queryClient.invalidateQueries({
            queryKey: workspaceQueryKeys.gitDiffRoot,
          });
          void queryClient.invalidateQueries({
            queryKey: workspaceQueryKeys.gitChangeStatsRoot,
          });
          if (toolName === "write" || toolName === "delete") {
            void queryClient.invalidateQueries({
              queryKey: workspaceQueryKeys.fileTreeRootRoot,
            });
          }
        }
      }
    }
  });

  useEffect(() => {
    const unsubscribe = window.api.agent.onEvent((event) => {
      handleIpcEvent(event);
    });
    return unsubscribe;
  }, []);
};
