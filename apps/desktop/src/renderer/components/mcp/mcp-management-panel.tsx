import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RefreshCw,
  ChevronDown,
  LoaderCircle,
  FileInput,
  Globe,
  Pencil,
  Plus,
  LogIn,
  RotateCw,
  Terminal,
  ToggleLeft,
  ToggleRight,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type {
  AgentMcpServer,
  AgentMcpStatus,
  McpMode,
  McpServerInfo,
  McpServerEntry,
} from "#shared/contracts";
import { ABACUS_CONNECTORS_SERVER_NAME } from "#shared/contracts";

import { useMcpRuntime } from "../../hooks/use-mcp-runtime";
import { settingsQueryKeys } from "../../lib/settings-query-keys";
import { useWorkspaceStore } from "../../stores/code-store";
import { Button, Spinner } from "../ui";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { AbacusConnectorsSummary } from "./abacus-connectors-summary";
import { McpServerForm } from "./mcp-server-form";

interface McpManagementPanelProps {
  /** On screen; the list re-read and runtime subscription run only then. */

  active: boolean;
  /** Rendered next to the add/import buttons. The dialog puts its Done button here. */
  trailingActions?: React.ReactNode;
}

type FormState =
  | { kind: "closed" }
  | { kind: "add" }
  | { kind: "add-prefill"; entry: McpServerEntry }
  | { kind: "edit"; name: string; entry: McpServerEntry };

type ImportSource =
  | "cursor"
  | "claude"
  | "abacusai-bot"
  | "deepagent"
  | "file"
  | "paste";

/**
 * MCP server management: the list, the add/edit form, imports, and live
 * per-server runtime status. Chrome-free: it is the body of both the settings
 * dialog and the Capabilities view's MCP tab.
 */
export const McpManagementPanel = ({
  active,
  trailingActions,
}: McpManagementPanelProps): React.ReactElement => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [activeMode] = useState<McpMode>("code");
  const [formState, setFormState] = useState<FormState>({ kind: "closed" });
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [clipboardHasMcp, setClipboardHasMcp] = useState(false);
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [signingIn, setSigningIn] = useState<string | null>(null);

  // Runtime status reflects the live agent session.
  const activeWorkspaceId = useWorkspaceStore(
    (state) => state.activeWorkspaceId
  );
  const getActiveSessionId = useWorkspaceStore(
    (state) => state.getActiveSessionId
  );
  const activeSessionId =
    activeWorkspaceId != null ? getActiveSessionId(activeWorkspaceId) : null;
  const runtimeEnabled = active;
  const {
    servers: runtimeServers,
    logs: runtimeLogs,
    refresh: refreshRuntime,
    restart: restartRuntime,
    reloadLogs,
  } = useMcpRuntime({
    workspaceId: runtimeEnabled ? activeWorkspaceId : null,
    sessionId: runtimeEnabled ? activeSessionId : null,
    enabled: runtimeEnabled,
    onAsyncError: useCallback(
      (evt) => {
        // CLI-side failures arrive asynchronously after `sendCommand` returns
        // success, so a toast is the only way the user learns the click failed.
        if (evt.kind === "refresh") {
          toast.error(t("mcpManagement.refreshFailed", { error: evt.error }));
        } else {
          toast.error(t("mcpManagement.restartFailed", { error: evt.error }));
        }
      },
      [t]
    ),
  });
  const hasLiveSession = runtimeEnabled && activeSessionId != null;

  const serversQuery = useQuery({
    queryKey: settingsQueryKeys.mcp.servers(activeMode),
    enabled: active,
    staleTime: 30_000,
    queryFn: async () =>
      (await window.api?.agent?.listMcpServers?.({ mode: activeMode })) ?? [],
  });
  const servers = serversQuery.data ?? [];
  const loading = serversQuery.isPending;
  const refreshServers = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({
      queryKey: settingsQueryKeys.mcp.servers(activeMode),
    });
  }, [activeMode, queryClient]);

  useEffect(() => {
    if (!active) return;
    setFormState({ kind: "closed" });
    setError(null);
  }, [active]);

  const checkClipboardForMcp = useCallback(async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text?.trim()) {
        setClipboardHasMcp(false);
        return;
      }
      const obj = JSON.parse(text) as unknown;
      if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
        setClipboardHasMcp(false);
        return;
      }
      const rec = obj as Record<string, unknown>;
      const hasWrapper = (["mcpServers", "mcp", "servers"] as const).some(
        (k) =>
          rec[k] != null && typeof rec[k] === "object" && !Array.isArray(rec[k])
      );
      const isSingle =
        typeof rec.command === "string" || typeof rec.url === "string";
      setClipboardHasMcp(hasWrapper || isSingle);
    } catch {
      setClipboardHasMcp(false);
    }
  }, []);

  const handleToggle = async (
    name: string,
    currentlyDisabled: boolean
  ): Promise<void> => {
    setError(null);
    const key = settingsQueryKeys.mcp.servers(activeMode);
    const previous = queryClient.getQueryData<McpServerInfo[]>(key);
    queryClient.setQueryData<McpServerInfo[]>(key, (current = []) =>
      current.map((server) =>
        server.id === name
          ? { ...server, disabled: !currentlyDisabled }
          : server
      )
    );
    const result = await window.api?.agent?.setMcpServerDisabled?.({
      mode: activeMode,
      name,
      disabled: !currentlyDisabled,
    });
    if (result?.success) {
      await refreshServers();
    } else {
      queryClient.setQueryData(key, previous ?? []);
      setError(result?.error ?? t("mcpManagement.toggleFailed"));
    }
  };

  const handleRemove = async (name: string): Promise<void> => {
    setError(null);
    const key = settingsQueryKeys.mcp.servers(activeMode);
    const previous = queryClient.getQueryData<McpServerInfo[]>(key);
    queryClient.setQueryData<McpServerInfo[]>(key, (current = []) =>
      current.filter((server) => server.id !== name)
    );
    const result = await window.api?.agent?.removeMcpServer?.({
      mode: activeMode,
      name,
    });
    if (result?.success) {
      await refreshServers();
    } else {
      queryClient.setQueryData(key, previous ?? []);
      setError(result?.error ?? t("mcpManagement.removeFailed"));
    }
  };

  const handleFormSave = async (
    name: string,
    entry: McpServerEntry
  ): Promise<{ success: boolean; error?: string }> => {
    const result =
      formState.kind === "edit"
        ? await window.api?.agent?.updateMcpServer?.({
            mode: activeMode,
            name,
            config: entry,
          })
        : await window.api?.agent?.addMcpServer?.({
            mode: activeMode,
            name,
            config: entry,
          });
    if (result?.success) {
      setFormState({ kind: "closed" });
      await refreshServers();
      return { success: true };
    }
    return { success: false, error: result?.error };
  };

  const handleImport = async (source: ImportSource): Promise<void> => {
    setImportOpen(false);
    setError(null);
    try {
      let result:
        | {
            success: boolean;
            error?: string;
            imported?: number;
            singleEntry?: McpServerEntry;
          }
        | undefined;
      if (source === "paste") {
        const text = await navigator.clipboard.readText();
        result = await window.api?.agent?.importMcpServers?.({
          mode: activeMode,
          source: "json",
          json: text,
        });
      } else if (source === "file") {
        result = await window.api?.agent?.importMcpServers?.({
          mode: activeMode,
          source: "file",
        });
      } else {
        result = await window.api?.agent?.importMcpServers?.({
          mode: activeMode,
          source,
        });
      }
      if (result?.success) {
        if (result.singleEntry != null) {
          setFormState({ kind: "add-prefill", entry: result.singleEntry });
          return;
        }
        const count = result.imported ?? 0;
        toast.success(t("mcpManagement.import.success", { count }));
        await refreshServers();
      } else if (result?.error != null) {
        setError(result.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSignIn = useCallback(
    async (serverId: string): Promise<void> => {
      setSigningIn(serverId);
      try {
        const result = await window.api.agent.mcpOAuthSignIn({
          mode: "code",
          name: serverId,
        });
        if (result.success) {
          toast.success(t("mcpManagement.signInDone", { name: serverId }));
          // Tokens are on disk; reconnecting is what makes the tools appear.
          if (hasLiveSession) await refreshRuntime();
        } else if (result.cancelled !== true) {
          toast.error(
            t("mcpManagement.signInFailed", { error: result.error ?? "" })
          );
        }
      } finally {
        setSigningIn(null);
      }
    },
    [hasLiveSession, refreshRuntime, t]
  );

  const handleRefreshRuntime = useCallback(async (): Promise<void> => {
    if (!hasLiveSession) {
      toast.info(t("mcpManagement.refreshNoSession"));
      return;
    }
    setRefreshing(true);
    try {
      const result = await refreshRuntime();
      if (result.success) toast.success(t("mcpManagement.refreshDone"));
      else
        toast.error(
          t("mcpManagement.refreshFailed", { error: result.error ?? "" })
        );
    } finally {
      setRefreshing(false);
    }
  }, [hasLiveSession, refreshRuntime, t]);

  const handleRestartRuntime = useCallback(
    async (serverId: string): Promise<void> => {
      const result = await restartRuntime(serverId);
      if (!result.success) {
        toast.error(
          t("mcpManagement.restartFailed", { error: result.error ?? "" })
        );
      }
    },
    [restartRuntime, t]
  );

  const toggleLogs = useCallback(
    (serverId: string): void => {
      const isOpen = expandedLogs.has(serverId);
      setExpandedLogs((prev) => {
        const next = new Set(prev);
        if (isOpen) next.delete(serverId);
        else next.add(serverId);
        return next;
      });
      // Pull a fresh tail outside the updater — side effects in updaters are unsafe.
      if (!isOpen) void reloadLogs(serverId);
    },
    [expandedLogs, reloadLogs]
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-id="mcp-management-panel"
    >
      <div className="flex shrink-0 flex-wrap justify-between gap-2 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => {
              setFormState({ kind: "add" });
              setError(null);
            }}
            data-id="mcp-add-btn"
          >
            <Plus />
            {t("mcpManagement.addServer")}
          </Button>
          <DropdownMenu
            open={importOpen}
            onOpenChange={(open) => {
              setImportOpen(open);
              if (open) void checkClipboardForMcp();
            }}
          >
            <DropdownMenuTrigger
              render={<Button variant="secondary" data-id="mcp-import-btn" />}
            >
              <FileInput />
              {t("mcpManagement.import.button")}
              <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="min-w-56"
              data-id="mcp-import-menu"
            >
              {clipboardHasMcp && (
                <ImportMenuItem
                  onClick={() => void handleImport("paste")}
                  label={t("mcpManagement.import.paste")}
                  dataId="paste"
                />
              )}
              <ImportMenuItem
                onClick={() => void handleImport("file")}
                label={t("mcpManagement.import.file")}
                dataId="file"
              />
              <DropdownMenuSeparator />
              <ImportMenuItem
                onClick={() => void handleImport("cursor")}
                label={t("mcpManagement.import.cursor")}
                dataId="cursor"
              />
              <ImportMenuItem
                onClick={() => void handleImport("claude")}
                label={t("mcpManagement.import.claude")}
                dataId="claude"
              />
              <ImportMenuItem
                onClick={() => void handleImport("deepagent")}
                label={t("mcpManagement.import.deepagent")}
                dataId="deepagent"
              />
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="secondary"
            onClick={() => void handleRefreshRuntime()}
            disabled={refreshing || !hasLiveSession}
            data-id="mcp-refresh-btn"
            title={
              hasLiveSession
                ? t("mcpManagement.refreshHint")
                : t("mcpManagement.refreshNoSession")
            }
          >
            <RefreshCw className={refreshing ? "animate-spin" : ""} />
            {t("mcpManagement.refresh")}
          </Button>
        </div>
        {trailingActions}
      </div>

      <div className="scroll-fade-y scrollbar-autohide min-h-0 flex-1 overflow-y-auto py-2">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner fontSize={20} />
          </div>
        ) : servers.length === 0 ? (
          <div className="text-muted-foreground py-8 text-center text-sm">
            {t("mcpManagement.noServers")}
          </div>
        ) : (
          <div className="space-y-2">
            {servers.map((server) => {
              const runtime = runtimeServers.get(server.id);
              const isExpanded = expandedLogs.has(server.id);
              const logTail = runtimeLogs.get(server.id) ?? [];
              return (
                <div
                  key={server.name}
                  className="bg-sidebar/60 border-border rounded-lg border"
                  data-id={`mcp-server-${server.name}`}
                >
                  <div className="flex items-center gap-3 px-3 py-2.5">
                    {server.config?.url ? (
                      <Globe className="text-muted-foreground size-3.5 shrink-0" />
                    ) : (
                      <Terminal className="text-muted-foreground size-3.5 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="text-foreground truncate text-sm font-medium">
                          {server.name}
                        </div>
                        {hasLiveSession && (
                          <RuntimeStatusPill
                            server={runtime}
                            disabled={server.config?.disabled === true}
                          />
                        )}
                      </div>
                      <div className="text-muted-foreground truncate text-xs">
                        {server.config?.url ??
                          `${server.config?.command ?? ""} ${(server.config?.args ?? []).join(" ")}`.trim()}
                      </div>
                      {server.name === ABACUS_CONNECTORS_SERVER_NAME && (
                        <AbacusConnectorsSummary />
                      )}
                      {runtime?.error != null && (
                        <div className="text-destructive mt-1 flex items-start gap-1 text-xs">
                          <TriangleAlert className="mt-0.5 size-2.5 shrink-0" />
                          <span className="break-words">{runtime.error}</span>
                        </div>
                      )}
                      {runtime?.status === "auth-required" && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          <span className="text-xs text-blue-600 dark:text-blue-300">
                            {t("mcpManagement.authRequiredHint", {
                              name: server.name,
                            })}
                          </span>
                          <Button
                            size="sm"
                            onClick={() => void handleSignIn(server.id)}
                            disabled={signingIn === server.id}
                            data-id={`mcp-server-signin-${server.id}`}
                          >
                            {signingIn === server.id ? (
                              <LoaderCircle className="animate-spin" />
                            ) : (
                              <LogIn />
                            )}
                            {signingIn === server.id
                              ? t("mcpManagement.signingIn")
                              : t("mcpManagement.signIn")}
                          </Button>
                        </div>
                      )}
                    </div>
                    {hasLiveSession && server.config?.disabled !== true && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void handleRestartRuntime(server.id)}
                        className="shrink-0"
                        data-id={`mcp-server-restart-${server.id}`}
                        title={t("mcpManagement.restart")}
                      >
                        <RotateCw />
                      </Button>
                    )}
                    {hasLiveSession && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => toggleLogs(server.id)}
                        className={`shrink-0 ${isExpanded ? "text-foreground" : ""}`}
                        data-id={`mcp-server-logs-${server.id}`}
                        title={
                          isExpanded
                            ? t("mcpManagement.hideLogs")
                            : t("mcpManagement.viewLogs")
                        }
                      >
                        <Terminal />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        handleToggle(
                          server.name,
                          server.config?.disabled === true
                        )
                      }
                      className="shrink-0"
                      data-id={`mcp-server-toggle-${server.name}`}
                      title={
                        server.config?.disabled
                          ? t("mcpManagement.enable")
                          : t("mcpManagement.disable")
                      }
                    >
                      {server.config?.disabled ? (
                        <ToggleLeft className="text-muted-foreground size-5" />
                      ) : (
                        <ToggleRight className="text-primary size-5" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        setFormState({
                          kind: "edit",
                          name: server.name,
                          entry: server.config,
                        })
                      }
                      className="shrink-0"
                      data-id={`mcp-server-edit-${server.name}`}
                      title={t("mcpManagement.edit")}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleRemove(server.name)}
                      className="hover:text-destructive shrink-0"
                      data-id={`mcp-server-remove-${server.name}`}
                      title={t("mcpManagement.remove")}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  {isExpanded && (
                    <div
                      className="text-secondary-foreground border-border -mt-1 max-h-40 overflow-y-auto border-t px-3 pt-2 pb-2 font-mono text-xs leading-snug"
                      data-id={`mcp-server-log-output-${server.name}`}
                    >
                      {logTail.length === 0 ? (
                        <div className="text-muted-foreground">
                          {t("mcpManagement.noLogs")}
                        </div>
                      ) : (
                        logTail.map((entry, idx) => (
                          <div
                            key={`${entry.ts}-${idx}`}
                            className="break-words whitespace-pre-wrap"
                          >
                            <span className="text-muted-foreground">
                              [{entry.source}/{entry.level}]
                            </span>{" "}
                            {entry.line}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {error && (
        <div className="shrink-0 py-2">
          <div className="text-destructive text-sm">{error}</div>
        </div>
      )}

      <Dialog
        open={formState.kind !== "closed"}
        onOpenChange={(open) => {
          if (!open) setFormState({ kind: "closed" });
        }}
      >
        {formState.kind !== "closed" && (
          <DialogContent
            className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl"
            data-id="mcp-management-panel-form"
          >
            <DialogHeader>
              <DialogTitle>
                {formState.kind === "edit"
                  ? t("mcpManagement.form.titleEdit", {
                      name: formState.name,
                    })
                  : t("mcpManagement.form.titleAdd")}
              </DialogTitle>
            </DialogHeader>
            <McpServerForm
              key={formState.kind === "edit" ? formState.name : "__new__"}
              initialName={formState.kind === "edit" ? formState.name : null}
              initialEntry={
                formState.kind === "edit"
                  ? formState.entry
                  : formState.kind === "add-prefill"
                    ? formState.entry
                    : null
              }
              onCancel={() => setFormState({ kind: "closed" })}
              onSave={handleFormSave}
            />
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
};

interface ImportMenuItemProps {
  onClick: () => void;
  label: string;
  dataId: string;
}

const ImportMenuItem = ({
  onClick,
  label,
  dataId,
}: ImportMenuItemProps): React.ReactElement => (
  <DropdownMenuItem onClick={onClick} data-id={`mcp-import-${dataId}`}>
    {label}
  </DropdownMenuItem>
);

interface RuntimeStatusPillProps {
  server: AgentMcpServer | undefined;
  disabled: boolean;
}

/**
 * Coloured chip for the live MCP connection state; 'idle' when the agent has
 * not reported on the server yet.
 */

const RuntimeStatusPill = ({
  server,
  disabled,
}: RuntimeStatusPillProps): React.ReactElement | null => {
  const { t } = useTranslation();
  if (disabled) return null;
  const status: AgentMcpStatus | "idle" = server?.status ?? "idle";
  const labelKey =
    status === "auth-required"
      ? "mcpManagement.runtimeStatus.authRequired"
      : `mcpManagement.runtimeStatus.${status === "idle" ? "idle" : status}`;
  const colour = pillColourClass(status);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.625rem] font-medium ${colour}`}
      data-id={`mcp-runtime-status-${server?.id ?? "unknown"}`}
      title={server?.error ?? undefined}
    >
      {status === "connecting" && (
        <Spinner fontSize={8} className="text-current" />
      )}
      {t(labelKey)}
      {server?.status === "connected" && server.toolCount > 0 && (
        <span className="opacity-70">
          · {t("mcpManagement.toolCount", { count: server.toolCount })}
        </span>
      )}
    </span>
  );
};

function pillColourClass(status: AgentMcpStatus | "idle"): string {
  switch (status) {
    case "connected":
      return "bg-emerald-500/20 text-emerald-600 dark:text-emerald-300";
    case "connecting":
      return "bg-amber-500/20 text-amber-600 dark:text-amber-300";
    case "error":
      return "bg-red-500/20 text-red-600 dark:text-red-300";
    case "auth-required":
      return "bg-blue-500/20 text-blue-600 dark:text-blue-300";
    case "disconnected":
    default:
      return "bg-muted text-muted-foreground";
  }
}
