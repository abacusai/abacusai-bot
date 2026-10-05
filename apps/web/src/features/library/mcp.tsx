import type {
  McpServerInfo,
  McpServerEntry,
  AgentMcpServer,
} from "@abacus-ai/contract/contracts";
import { useLiveQuery } from "@tanstack/react-db";
import { revalidateLogic } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { useAppForm } from "#renderer/components/form-kit";
import { ConfirmAction } from "#renderer/components/form-kit/confirm";
import {
  AreaPage,
  GroupCard,
  SettingRow,
  StatePill,
} from "#renderer/components/form-kit/page";
import { useCollections } from "#renderer/data/db";
import { followNotices } from "#renderer/data/queries/live";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { showError, showInfo } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "#renderer/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "#renderer/ui/field";
import { Input } from "#renderer/ui/input";
import { NativeSelect, NativeSelectOption } from "#renderer/ui/native-select";
import { Textarea } from "#renderer/ui/textarea";
export const useMcpRuntimeScope = () => {
  const c = useCollections();
  const sessions = useLiveQuery(c.sessions).data ?? [];
  const candidates = sessions
    .filter((s) => s.status === "running")
    .toSorted((a, b) =>
      (b.turn?.updatedAt ?? b.updatedAt).localeCompare(
        a.turn?.updatedAt ?? a.updatedAt
      )
    );
  const [picked, setPicked] = useState<string | null>(null);
  const session = candidates.find((s) => s.id === picked) ?? candidates[0];
  const scope = session
    ? { workspaceId: session.workspaceId, sessionId: session.id }
    : null;
  return {
    candidates,
    session,
    setPicked,
    scope,
  };
};
export const McpPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const navigate = useAppNavigate();
  const search = useSearch({ strict: false }) as {
    server?: string;
    logs?: string;
  };
  const query = useQuery(
    transport.orpc.mcp.list.queryOptions({ input: { mode: "code" } })
  );
  const { scope, candidates, session, setPicked } = useMcpRuntimeScope();
  const sessionId = scope?.sessionId;
  const workspaceId = scope?.workspaceId;
  const [runtime, setRuntime] = useState<AgentMcpServer[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [prefill, setPrefill] = useState<McpServerInfo | null>(null);
  useEffect(() => {
    // Selecting a different external runtime retires the previous snapshot.
    // eslint-disable-next-line react/set-state-in-effect
    setRuntime([]);
    setLogs([]);
    if (!sessionId || !workspaceId) return;
    const scope = { sessionId, workspaceId };
    const abort = new AbortController();
    void transport.client.mcp.runtime
      .servers(scope)
      .then((rows) => {
        if (!abort.signal.aborted) setRuntime(rows);
      })
      .catch(() => undefined);
    void followNotices(
      transport,
      ({ signal }) =>
        transport.client.mcp.runtime.events(
          { sessionId: scope.sessionId },
          { signal }
        ),
      (event) => {
        if (event.type === "servers") setRuntime(event.servers);
        if (event.type === "status")
          setRuntime((rows) =>
            rows.map((r) =>
              r.id === event.serverId
                ? {
                    ...r,
                    status: event.status,
                    ...(event.error ? { error: event.error } : {}),
                  }
                : r
            )
          );
        if (event.type === "log" && event.entry.serverId === search.logs)
          setLogs((rows) => [...rows, event.entry.line].slice(-200));
        if (event.type === "refresh-failed" || event.type === "restart-failed")
          showError(event.error);
      },
      abort.signal
    );
    return () => abort.abort();
  }, [transport, sessionId, workspaceId, search.logs]);
  useEffect(() => {
    let live = true;
    if (sessionId && workspaceId && search.logs)
      void transport.client.mcp.runtime
        .logs({ sessionId, workspaceId, serverId: search.logs })
        .then((entries) => {
          if (live) setLogs(entries.slice(-200).map((entry) => entry.line));
        })
        .catch(() => {
          if (live) showError(t("phase5.failed"));
        });
    return () => {
      live = false;
    };
  }, [transport, sessionId, workspaceId, search.logs, t]);
  const mutate = async (
    call: Promise<{ success: boolean; error?: string }>
  ) => {
    const result = await call;
    if (!result.success) throw new Error(result.error ?? t("phase5.failed"));
    await cache.invalidateQueries({
      queryKey: transport.orpc.mcp.list.queryKey({ input: { mode: "code" } }),
    });
  };
  const importServers = async (
    source: "claude" | "cursor" | "deepagent" | "file" | "json"
  ) => {
    if (!IS_ELECTRON && source === "file") return;
    try {
      const result = await transport.client.mcp.import({
        mode: "code",
        source,
        ...(source === "json"
          ? { json: await navigator.clipboard.readText() }
          : {}),
      });
      if (!result.success) {
        showError(result.error ?? t("phase5.failed"));
        return;
      }
      if (result.singleEntry) {
        setPrefill({
          id: "new",
          name: "",
          config: result.singleEntry,
          isBuiltin: false,
        });
        void navigate({
          to: "/library/mcp",
          search: { server: "new" },
          transition: "none",
        });
      }
      await cache.invalidateQueries({
        queryKey: transport.orpc.mcp.list.queryKey({ input: { mode: "code" } }),
      });
    } catch (e) {
      showError(e instanceof Error ? e.message : t("phase5.failed"));
    }
  };
  return (
    <>
      <AreaPage
        title={t("library.pages.mcp")}
        description={scope ? t("phase5.mcpLive") : t("phase5.mcpNoSession")}
        actions={
          <Button
            size="sm"
            onClick={() =>
              void navigate({
                to: "/library/mcp",
                search: { server: "new" },
                transition: "none",
              })
            }
          >
            {t("phase5.addServer")}
          </Button>
        }
      >
        <div className="flex flex-wrap gap-2">
          {(["claude", "cursor", "deepagent", "file", "json"] as const)
            .filter((source) => IS_ELECTRON || source !== "file")
            .map((source) => (
              <Button
                key={source}
                size="sm"
                variant="secondary"
                onClick={() => void importServers(source)}
              >
                {t(`phase5.imports.${source}`)}
              </Button>
            ))}
          <Button
            size="sm"
            disabled={!scope}
            title={t("phase5.mcpNoSession")}
            onClick={() =>
              scope &&
              void transport.client.mcp
                .refresh(scope)
                .then((result) => {
                  if (result.success) showInfo(t("phase5.refreshed"));
                  else showError(result.error ?? t("phase5.failed"));
                })
                .catch(() => showError(t("phase5.failed")))
            }
          >
            {t("phase5.refresh")}
          </Button>
        </div>
        {scope && (
          <NativeSelect
            aria-label={t("phase5.runtimeScope")}
            value={session?.id ?? ""}
            onChange={(e) => setPicked(e.target.value)}
          >
            {candidates.map((s) => (
              <NativeSelectOption key={s.id} value={s.id}>
                {s.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        <GroupCard>
          {query.data?.map((server) => {
            const live = runtime.find((r) => r.id === server.id);
            return (
              <div key={server.id}>
                <SettingRow
                  id={server.id}
                  title={server.name}
                  detail={
                    server.config.url ??
                    [server.config.command, ...(server.config.args ?? [])].join(
                      " "
                    )
                  }
                >
                  <StatePill>
                    {server.config.disabled
                      ? t("phase5.disabled")
                      : t(
                          live?.status === "connected"
                            ? "phase5.connected"
                            : live?.status === "connecting"
                              ? "phase5.connecting"
                              : live?.status === "error"
                                ? "phase5.failed"
                                : live?.status === "auth-required"
                                  ? "phase5.authRequired"
                                  : "phase5.notConnected"
                        )}
                  </StatePill>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      void navigate({
                        to: "/library/mcp",
                        search: { server: server.name },
                        transition: "none",
                      })
                    }
                  >
                    {t("phase5.edit")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void mutate(
                        transport.client.mcp.setDisabled({
                          mode: "code",
                          name: server.name,
                          disabled: !server.config.disabled,
                        })
                      ).catch(() => showError(t("phase5.failed")))
                    }
                  >
                    {t(
                      server.config.disabled
                        ? "phase5.enable"
                        : "phase5.disable"
                    )}
                  </Button>
                  <ConfirmAction
                    title={t("phase5.removeServer")}
                    description={t("phase5.removeServerDescription")}
                    label={t("phase5.remove")}
                    onConfirm={() =>
                      mutate(
                        transport.client.mcp.remove({
                          mode: "code",
                          name: server.name,
                        })
                      )
                    }
                  />
                </SettingRow>
                <div className="bg-muted/30 flex flex-wrap gap-2 border-t px-3 py-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!scope || server.config.disabled}
                    onClick={() =>
                      scope &&
                      void transport.client.mcp
                        .restart({
                          ...scope,
                          serverId: server.id,
                        })
                        .then((result) => {
                          if (!result.success)
                            showError(result.error ?? t("phase5.failed"));
                        })
                        .catch(() => showError(t("phase5.failed")))
                    }
                  >
                    {t("phase5.restart")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!scope}
                    onClick={() =>
                      void navigate({
                        to: "/library/mcp",
                        search: {
                          logs:
                            search.logs === server.name
                              ? undefined
                              : server.name,
                        },
                        transition: "none",
                      })
                    }
                  >
                    {t("phase5.logs")}
                  </Button>
                  {IS_ELECTRON && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void transport.client.mcp
                          .oauthSignIn({ mode: "code", name: server.name })
                          .then(async (result) => {
                            if (result.cancelled) return;
                            if (!result.success) {
                              showError(result.error ?? t("phase5.failed"));
                              return;
                            }
                            if (scope) {
                              const refreshed =
                                await transport.client.mcp.refresh(scope);
                              if (!refreshed.success)
                                showError(
                                  refreshed.error ?? t("phase5.failed")
                                );
                            }
                          })
                          .catch(() => showError(t("phase5.failed")))
                      }
                    >
                      {t("phase5.signIn")}
                    </Button>
                  )}
                </div>
                {search.logs === server.name && (
                  <pre
                    role="log"
                    aria-live="off"
                    className="max-h-60 overflow-auto p-3 text-xs"
                  >
                    {logs.join("\n") || t("phase5.noLogs")}
                  </pre>
                )}
              </div>
            );
          })}
        </GroupCard>
      </AreaPage>
      {search.server && (
        <McpServerDialog
          name={search.server}
          servers={query.data ?? []}
          prefill={prefill}
        />
      )}
    </>
  );
};
export const McpFormSchema = v.pipe(
  v.object({
    name: v.pipe(v.string(), v.trim(), v.minLength(1)),
    transport: v.picklist(["stdio", "http"]),
    command: v.pipe(v.string(), v.trim()),
    url: v.pipe(v.string(), v.trim()),
    args: v.string(),
    env: v.string(),
    headers: v.string(),
    clientId: v.string(),
    clientSecret: v.string(),
    scope: v.string(),
  }),
  v.check(
    (x) =>
      x.transport === "stdio"
        ? x.command.length > 0
        : (() => {
            try {
              return ["http:", "https:"].includes(new URL(x.url).protocol);
            } catch {
              return false;
            }
          })(),
    "invalid-server"
  )
);
const keyValues = (text: string) =>
  Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i).trim(), line.slice(i + 1)];
      })
      .filter(([key]) => key)
  );
export const configFromForm = (
  value: v.InferOutput<typeof McpFormSchema>
): McpServerEntry =>
  value.transport === "stdio"
    ? {
        command: value.command,
        args: value.args
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean),
        env: keyValues(value.env),
      }
    : {
        url: value.url,
        headers: keyValues(value.headers),
        ...([value.clientId, value.clientSecret, value.scope].some(Boolean)
          ? {
              oauth: {
                clientId: value.clientId,
                clientSecret: value.clientSecret,
                scope: value.scope,
              },
            }
          : {}),
      };
const formValuesFor = (entry: McpServerInfo | undefined | null) => {
  const config = entry?.config;
  return {
    name: entry?.name ?? "",
    transport: config?.url ? ("http" as const) : ("stdio" as const),
    command: config?.command ?? "",
    url: config?.url ?? "",
    args: config?.args?.join("\n") ?? "",
    env: Object.entries(config?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    headers: Object.entries(config?.headers ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    clientId:
      typeof config?.oauth === "object" ? (config.oauth.clientId ?? "") : "",
    clientSecret:
      typeof config?.oauth === "object"
        ? (config.oauth.clientSecret ?? "")
        : "",
    scope: typeof config?.oauth === "object" ? (config.oauth.scope ?? "") : "",
  };
};
export const McpServerDialog = ({
  name,
  servers,
  prefill,
}: {
  name: string;
  servers: McpServerInfo[];
  prefill: McpServerInfo | null;
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const navigate = useAppNavigate();
  const entry = name === "new" ? prefill : servers.find((s) => s.name === name);
  const [error, setError] = useState<string | null>(null);
  const close = () =>
    void navigate({
      to: "/library/mcp",
      search: { server: undefined },
      transition: "none",
    });
  const incoming = formValuesFor(entry);
  const baseline = useRef(incoming);
  const [remoteChanged, setRemoteChanged] = useState(false);
  const form = useAppForm({
    defaultValues: incoming,
    validationLogic: revalidateLogic({
      mode: "blur",
      modeAfterSubmission: "change",
    }),
    validators: { onDynamic: McpFormSchema },
    onSubmit: async ({ value }) => {
      const parsed = v.parse(McpFormSchema, value);
      try {
        const result = await transport.client.mcp[
          name === "new" ? "add" : "update"
        ]({ mode: "code", name: parsed.name, config: configFromForm(parsed) });
        if (!result.success) {
          setError(result.error ?? t("phase5.failed"));
          return;
        }
        await cache.invalidateQueries({
          queryKey: transport.orpc.mcp.list.queryKey({
            input: { mode: "code" },
          }),
        });
        close();
      } catch (e) {
        setError(e instanceof Error ? e.message : t("phase5.failed"));
      }
    },
  });
  useEffect(() => {
    if (!entry) return;
    const incoming = formValuesFor(entry);
    for (const key of Object.keys(incoming) as Array<keyof typeof incoming>) {
      if (incoming[key] === baseline.current[key]) continue;
      if (form.state.values[key] === baseline.current[key])
        form.setFieldValue(key, incoming[key], {
          dontUpdateMeta: true,
          dontValidate: true,
          dontRunListeners: true,
        });
      else setRemoteChanged(true);
    }
    baseline.current = incoming;
  }, [entry, form]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t("phase5.customMcp")}</DialogTitle>
          <DialogDescription>{t("phase5.mcpLive")}</DialogDescription>
        </DialogHeader>
        {remoteChanged && <p role="status">{t("phase5.remoteChanged")}</p>}
        {name !== "new" && !entry ? (
          <p>{t("phase5.serverGone")}</p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
          >
            <FieldGroup>
              <form.Field name="transport">
                {(f) => (
                  <Field>
                    <FieldLabel htmlFor="mcp-transport">
                      {t("phase5.transport")}
                    </FieldLabel>
                    <NativeSelect
                      id="mcp-transport"
                      value={f.state.value}
                      onChange={(e) =>
                        f.handleChange(e.target.value as "stdio" | "http")
                      }
                    >
                      <NativeSelectOption value="stdio">
                        STDIO
                      </NativeSelectOption>
                      <NativeSelectOption value="http">
                        Streamable HTTP
                      </NativeSelectOption>
                    </NativeSelect>
                  </Field>
                )}
              </form.Field>
              <form.Subscribe selector={(state) => state.values.transport}>
                {(transport) => (
                  <>
                    {(
                      [
                        "name",
                        "command",
                        "url",
                        "args",
                        "env",
                        "headers",
                        "clientId",
                        "clientSecret",
                        "scope",
                      ] as const
                    )
                      .filter(
                        (key) =>
                          key === "name" ||
                          (transport === "stdio"
                            ? ["command", "args", "env"].includes(key)
                            : [
                                "url",
                                "headers",
                                "clientId",
                                "clientSecret",
                                "scope",
                              ].includes(key))
                      )
                      .map((key) => (
                        <form.Field key={key} name={key}>
                          {(f) => (
                            <Field>
                              <FieldLabel htmlFor={`mcp-${key}`}>
                                {t(`phase5.mcpFields.${key}`)}
                              </FieldLabel>
                              {["args", "env", "headers"].includes(key) ? (
                                <Textarea
                                  id={`mcp-${key}`}
                                  value={f.state.value}
                                  onChange={(e) =>
                                    f.handleChange(e.target.value)
                                  }
                                  onBlur={f.handleBlur}
                                />
                              ) : (
                                <Input
                                  id={`mcp-${key}`}
                                  value={f.state.value}
                                  disabled={key === "name" && name !== "new"}
                                  type={
                                    key === "clientSecret" ? "password" : "text"
                                  }
                                  onChange={(e) =>
                                    f.handleChange(e.target.value)
                                  }
                                  onBlur={f.handleBlur}
                                />
                              )}
                            </Field>
                          )}
                        </form.Field>
                      ))}
                  </>
                )}
              </form.Subscribe>
              <form.Subscribe selector={(state) => state.isValid}>
                {(valid) =>
                  valid ? null : <p role="alert">{t("phase5.invalidMcp")}</p>
                }
              </form.Subscribe>
              {error && <p role="alert">{error}</p>}
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={close}>
                  {t("phase5.cancel")}
                </Button>
                <form.AppForm>
                  <form.SubmitButton label={t("phase5.save")} />
                </form.AppForm>
              </DialogFooter>
            </FieldGroup>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
};
