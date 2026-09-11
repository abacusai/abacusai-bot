import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AgentMcpLogEntry,
  AgentMcpServer,
  AgentMcpStatus,
} from "#shared/contracts";

interface UseMcpRuntimeArgs {
  workspaceId: string | null;
  sessionId: string | null;
  /** Set false to skip subscription entirely (e.g. dialog is closed). */
  enabled?: boolean;
  /**
   * Fires for CLI-side failures of `refresh`/`restart`: the IPC call only
   * says the command reached stdin; the failure arrives as an ndjson event.
   */
  onAsyncError?: (
    event:
      | { kind: "refresh"; error: string }
      | { kind: "restart"; serverId: string; error: string }
  ) => void;
}

interface UseMcpRuntimeResult {
  /** Per-server-id runtime snapshot. Empty when no session is running. */
  servers: Map<string, AgentMcpServer>;
  /** Per-server-id log tail (newest last). */
  logs: Map<string, AgentMcpLogEntry[]>;
  refresh: () => Promise<{ success: boolean; error?: string }>;
  restart: (serverId: string) => Promise<{ success: boolean; error?: string }>;
  reloadLogs: (serverId: string) => Promise<void>;
}

const MAX_LOG_TAIL = 200;

/**
 * Per-server MCP status and log tail from the active CLI session, for the MCP
 * dialog. Empty maps when no session runs; the dialog then shows disk data.
 */
export function useMcpRuntime({
  workspaceId,
  sessionId,
  enabled = true,
  onAsyncError,
}: UseMcpRuntimeArgs): UseMcpRuntimeResult {
  const [servers, setServers] = useState<Map<string, AgentMcpServer>>(
    () => new Map()
  );
  const [logs, setLogs] = useState<Map<string, AgentMcpLogEntry[]>>(
    () => new Map()
  );
  // A ref, so a new callback identity doesn't tear down the subscription.
  const onAsyncErrorRef = useRef(onAsyncError);
  useEffect(() => {
    onAsyncErrorRef.current = onAsyncError;
  });

  useEffect(() => {
    if (!enabled || workspaceId == null || sessionId == null) {
      setServers(new Map());
      setLogs(new Map());
      return;
    }
    let cancelled = false;

    void (async () => {
      try {
        const initial = await window.api?.agent?.getMcpRuntimeServers?.({
          workspaceId,
          sessionId,
        });
        if (cancelled) return;
        const next = new Map<string, AgentMcpServer>();
        for (const s of initial ?? []) next.set(s.id, s);
        setServers(next);
      } catch {
        // best-effort hydrate; live events still arrive
      }
    })();

    const unsubscribe = window.api?.agent?.onEvent?.((event) => {
      if (
        event.type === "mcp-runtime-servers" &&
        event.workspaceId === workspaceId &&
        event.sessionId === sessionId
      ) {
        const next = new Map<string, AgentMcpServer>();
        for (const s of event.servers) next.set(s.id, s);
        setServers(next);
      } else if (
        event.type === "mcp-runtime-status" &&
        event.workspaceId === workspaceId &&
        event.sessionId === sessionId
      ) {
        setServers((prev) => mergeServerStatus(prev, event));
      } else if (
        event.type === "mcp-runtime-log" &&
        event.workspaceId === workspaceId &&
        event.sessionId === sessionId
      ) {
        setLogs((prev) => appendLogEntry(prev, event.entry));
      } else if (
        event.type === "mcp-runtime-refresh-failed" &&
        event.workspaceId === workspaceId &&
        event.sessionId === sessionId
      ) {
        onAsyncErrorRef.current?.({ kind: "refresh", error: event.error });
      } else if (
        event.type === "mcp-runtime-restart-failed" &&
        event.workspaceId === workspaceId &&
        event.sessionId === sessionId
      ) {
        onAsyncErrorRef.current?.({
          kind: "restart",
          serverId: event.serverId,
          error: event.error,
        });
      }
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [workspaceId, sessionId, enabled]);

  const refresh = useCallback(async () => {
    if (workspaceId == null || sessionId == null) {
      return { success: false, error: "no-session" as const };
    }
    return (
      (await window.api?.agent?.refreshMcpServers?.({
        workspaceId,
        sessionId,
      })) ?? {
        success: false,
        error: "no-session",
      }
    );
  }, [workspaceId, sessionId]);

  const restart = useCallback(
    async (serverId: string) => {
      if (workspaceId == null || sessionId == null) {
        return { success: false, error: "no-session" as const };
      }
      return (
        (await window.api?.agent?.restartMcpServer?.({
          workspaceId,
          sessionId,
          serverId,
        })) ?? {
          success: false,
          error: "no-session",
        }
      );
    },
    [workspaceId, sessionId]
  );

  const reloadLogs = useCallback(
    async (serverId: string) => {
      if (workspaceId == null || sessionId == null) return;
      const entries = await window.api?.agent?.getMcpServerLogs?.({
        workspaceId,
        sessionId,
        serverId,
      });
      if (entries == null) return;
      setLogs((prev) => {
        const next = new Map(prev);
        next.set(serverId, [...entries]);
        return next;
      });
    },
    [workspaceId, sessionId]
  );

  return { servers, logs, refresh, restart, reloadLogs };
}

function mergeServerStatus(
  prev: Map<string, AgentMcpServer>,
  evt: {
    serverId: string;
    status: AgentMcpStatus;
    error?: string;
    authUrl?: string;
    pid?: number;
    ts: string;
  }
): Map<string, AgentMcpServer> {
  const existing = prev.get(evt.serverId);
  const next: AgentMcpServer = {
    id: evt.serverId,
    name: existing?.name ?? evt.serverId,
    transport: existing?.transport ?? "unknown",
    // Only the `mcp-runtime-servers` snapshot is authoritative for toolCount.
    toolCount: existing?.toolCount ?? 0,
    status: evt.status,
    updatedAt: evt.ts,
    ...(evt.error != null ? { error: evt.error } : {}),
    ...(evt.authUrl != null ? { authUrl: evt.authUrl } : {}),
    ...(evt.pid != null ? { pid: evt.pid } : {}),
    ...(existing?.connectedAt != null
      ? { connectedAt: existing.connectedAt }
      : {}),
  };
  if (evt.status === "connected") next.connectedAt = evt.ts;
  const result = new Map(prev);
  result.set(evt.serverId, next);
  return result;
}

function appendLogEntry(
  prev: Map<string, AgentMcpLogEntry[]>,
  entry: AgentMcpLogEntry
): Map<string, AgentMcpLogEntry[]> {
  const tail = prev.get(entry.serverId) ?? [];
  const next = new Map(prev);
  next.set(entry.serverId, [...tail, entry].slice(-MAX_LOG_TAIL));
  return next;
}
