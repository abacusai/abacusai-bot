import {
  CONNECTORS,
  connectFields,
  connectorById,
  type Connector,
} from "@abacus-ai/connectors/registry";
import type {
  ConnectorStatus,
  ConnectorStatuses,
} from "@abacus-ai/contract/contracts";
import { revalidateLogic } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { ConnectorMark } from "#renderer/components/connector-mark";
import { useAppForm } from "#renderer/components/form-kit";
import { ConfirmAction } from "#renderer/components/form-kit/confirm";
import {
  CONNECT_ACTION,
  CONNECT_PRIMARY,
  ConnectDialogContent,
  ConnectHeader,
  ConnectNote,
  ConnectPending,
  ConnectStep,
  ConnectWaiting,
} from "#renderer/components/form-kit/connect-dialog";
import { Segments } from "#renderer/components/form-kit/controls";
import {
  AreaPage,
  GroupCard,
  SettingRow,
  StatePill,
} from "#renderer/components/form-kit/page";
import { connectErrorText } from "#renderer/lib/connect-page";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem } from "#renderer/lib/platform-system";
import { useAppContext, foldSearch } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import { Dialog } from "#renderer/ui/dialog";
import { Field, FieldLabel, FieldGroup } from "#renderer/ui/field";
import { Input } from "#renderer/ui/input";

import { useConnectFlow } from "./connect-flow";
import { CONNECTOR_CATEGORY_TABS } from "./search";
export const visibleTabsFor = (entry: Connector): string[] =>
  entry.kind === "messaging"
    ? ["messaging", "featured"]
    : entry.category === "abacus-connectors"
      ? entry.onboarding
        ? ["abacus", "featured"]
        : ["abacus"]
      : [entry.category];
/** Abacus could not be read and nothing was known before: neither connected nor not. */
const uncheckable = (status: ConnectorStatus | undefined): boolean =>
  status?.state === "unavailable" && status?.reason === "unavailable";
/** Read from Abacus last time rather than now, or not read at all. */
const unconfirmed = (statuses: ConnectorStatuses | undefined) => {
  const all = Object.values(statuses ?? {});
  return {
    stale: all.some((status) => status.stale === true),
    unchecked: all.some(uncheckable),
  };
};
/** While Abacus cannot be read, the page asks again on its own this often. */
const UNCONFIRMED_REFETCH_MS = 15_000;
export const ConnectorsPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const search = useSearch({ strict: false }) as {
    category?: string;
    q?: string;
  };
  const navigate = useAppNavigate({ from: "/library/connectors" });
  const flow = useConnectFlow();
  const statuses = useQuery({
    ...transport.orpc.connectors.statuses.queryOptions({ input: {} }),
    staleTime: 60000,
    // Only while the shown state is not a fresh read: back to fresh once Abacus answers.
    refetchInterval: (query) => {
      const { stale, unchecked } = unconfirmed(query.state.data);
      return stale || unchecked ? UNCONFIRMED_REFETCH_MS : false;
    },
  });
  // Chat apps pair from the desktop; a browser has no pairing.
  const offered = CONNECTORS.filter(
    (e) =>
      (IS_ELECTRON || e.kind !== "messaging") &&
      statuses.data?.[e.id]?.reason !== "not-offered"
  );
  // Only categories with something in them; Featured always leads.
  const tabs = CONNECTOR_CATEGORY_TABS.filter(
    (tab) =>
      tab === "featured" || offered.some((e) => visibleTabsFor(e).includes(tab))
  );
  // A link to a category with nothing in it lands on Featured.
  const category = tabs.find((tab) => tab === search.category) ?? "featured";
  const entries = offered.filter((e) =>
    search.q
      ? foldSearch(e.name + " " + e.description).includes(foldSearch(search.q))
      : visibleTabsFor(e).includes(category)
  );
  const connected = (id: string) =>
    ["connected", "pending"].includes(statuses.data?.[id]?.state ?? "");
  const { stale, unchecked } = unconfirmed(statuses.data);
  // Abacus answers again: a Connect that could not reach it is no longer the news.
  const reachable = statuses.data != null && !stale && !unchecked;
  useEffect(() => {
    if (reachable)
      flow.store.setState((state) =>
        state.error === "unreachable" ? { ...state, error: undefined } : state
      );
  }, [reachable, flow.store]);
  return (
    <AreaPage
      testId="connectors-page"
      title={t("library.pages.connectors")}
      description={t("phase5.connectorsDescription")}
    >
      <Input
        aria-label={t("phase5.searchConnectors")}
        placeholder={t("phase5.searchConnectors")}
        value={search.q ?? ""}
        onChange={(e) =>
          void navigate({
            to: "/library/connectors",
            search: (p) => ({ ...p, q: e.target.value || undefined }),
            replace: true,
            transition: "none",
          })
        }
      />
      {!search.q && (
        <Segments
          label={t("phase5.category")}
          value={category}
          values={tabs.map((value) => ({
            value,
            label: t(`phase5.categories.${value}`),
          }))}
          onChange={(category) =>
            void navigate({
              to: "/library/connectors",
              search: (p) => ({
                ...p,
                category: category as (typeof CONNECTOR_CATEGORY_TABS)[number],
              }),
              transition: "none",
            })
          }
        />
      )}
      {(stale || unchecked) && (
        <ConnectNote>
          {t(
            stale ? "phase5.connectorsLastSeen" : "phase5.connectorsUnchecked"
          )}
        </ConnectNote>
      )}
      {[true, false].map((group) => {
        const rows = entries.filter((e) => connected(e.id) === group);
        if (rows.length === 0) return null;
        return (
          <section key={String(group)}>
            <h2 className="mb-2 text-sm font-semibold">
              {t(group ? "phase5.connected" : "phase5.available")}
            </h2>
            <GroupCard>
              {rows.map((e) => {
                // Installed, but its sign-in never finished: offer the sign-in.
                const signIn =
                  statuses.data?.[e.id]?.reason === "sign-in-required";
                const cantCheck = uncheckable(statuses.data?.[e.id]);
                const inFlight =
                  flow.state.connectorId === e.id &&
                  flow.state.phase !== "idle" &&
                  flow.state.phase !== "fields";
                // The connect error sits under the row it came from.
                const error =
                  flow.state.connectorId === e.id
                    ? flow.state.error
                    : undefined;
                return (
                  <div key={e.id}>
                    <SettingRow
                      id={e.id}
                      title={e.name}
                      detail={statuses.data?.[e.id]?.account ?? e.description}
                      media={<ConnectorMark id={e.logo ?? e.id} size={40} />}
                    >
                      {/* The section heading already says it; a phone folds the pill. */}
                      <span
                        className={
                          signIn ? "contents" : "phone:hidden contents"
                        }
                      >
                        <StatePill
                          tone={
                            signIn ? "warning" : group ? "success" : "neutral"
                          }
                        >
                          {t(
                            signIn
                              ? "phase5.signInNeeded"
                              : group
                                ? "phase5.connected"
                                : cantCheck
                                  ? "phase5.cantCheck"
                                  : "phase5.available"
                          )}
                        </StatePill>
                      </span>
                      {inFlight ? (
                        // The wait is this row's: every other row, the search
                        // and navigation stay usable, and Cancel is beside it.
                        <ConnectPending onCancel={() => void flow.cancel()} />
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            if (group && !signIn && e.kind === "messaging")
                              void navigate({
                                to: "/library/messaging",
                                search: { platform: e.platform },
                                transition: "none",
                              });
                            else if (group && !signIn)
                              void navigate({
                                to: "/library/connectors",
                                search: (p) => ({ ...p, connector: e.id }),
                                transition: "none",
                              });
                            else void flow.start(e.id);
                          }}
                        >
                          {t(
                            signIn
                              ? "phase5.signIn"
                              : group
                                ? "phase5.manage"
                                : "phase5.add"
                          )}
                        </Button>
                      )}
                    </SettingRow>
                    {error && (
                      <ConnectNote error className="px-3 pb-2.5">
                        {connectErrorText(t, error)}
                      </ConnectNote>
                    )}
                  </div>
                );
              })}
            </GroupCard>
          </section>
        );
      })}
    </AreaPage>
  );
};
export const ConnectorDialog = ({ connector }: { connector: string }) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const flow = useConnectFlow();
  const navigate = useAppNavigate({ from: "/library/connectors" });
  const entry = connectorById(connector);
  const statuses = useQuery(
    transport.orpc.connectors.statuses.queryOptions({ input: {} })
  );
  const status = statuses.data?.[connector];
  const connected = status?.state === "connected";
  const signIn = status?.reason === "sign-in-required";
  const cantCheck = uncheckable(status);
  const waiting =
    flow.state.connectorId === connector && flow.state.phase !== "idle";
  const tools =
    entry?.kind === "platform"
      ? entry.via != null
        ? [entry.via]
        : entry.tools
      : entry?.kind === "mcp"
        ? [entry.entry.url ?? entry.entry.command ?? ""].filter(Boolean)
        : [];
  const close = () =>
    void navigate({
      to: "/library/connectors",
      search: (p) => ({ ...p, connector: undefined }),
      transition: "none",
    });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <ConnectDialogContent
        data-testid="connector-dialog"
        className="sm:max-w-[440px]"
      >
        <ConnectHeader
          mark={<ConnectorMark id={entry?.logo ?? connector} size={32} />}
          title={entry?.name ?? connector}
          status={
            status && {
              label: t(
                connected
                  ? "phase5.connected"
                  : signIn
                    ? "phase5.signInNeeded"
                    : cantCheck
                      ? "phase5.cantCheck"
                      : "phase5.notConnected"
              ),
              tone: connected ? "success" : "warning",
            }
          }
          description={entry?.description}
        />
        <div className="flex min-w-0 flex-col gap-4 text-[15px] leading-[21px]">
          <p className="text-muted-foreground">
            {status?.account ?? entry?.description}
          </p>
          {tools.length > 0 && (
            <section className="flex flex-col gap-2">
              <span className="font-medium">{t("phase5.whatItCanDo")}</span>
              <div className="flex flex-wrap gap-1.5">
                {tools.map((tool) => (
                  <code
                    key={tool}
                    className="bg-muted rounded-md px-1.5 py-0.5 font-mono text-xs"
                  >
                    {tool}
                  </code>
                ))}
              </div>
            </section>
          )}
          {entry?.setup && entry.setup.length > 0 && (
            <ol className="flex flex-col gap-3">
              {entry.setup.map((step, index) => (
                <ConnectStep
                  key={step}
                  index={entry.setup!.length > 1 ? index + 1 : undefined}
                  done={connected}
                >
                  <ConnectNote>{step}</ConnectNote>
                </ConnectStep>
              ))}
            </ol>
          )}
          {entry?.docsUrl && (
            <Button
              size="sm"
              variant="secondary"
              className={CONNECT_ACTION}
              onClick={() =>
                void platformSystem(transport.client).openExternal({
                  url: entry.docsUrl,
                })
              }
            >
              <ExternalLinkIcon data-icon="inline-start" />
              {t("phase5.documentation")}
            </Button>
          )}
          {waiting && (
            <ConnectWaiting className="justify-center">
              {t("phase5.connectWaiting")}
            </ConnectWaiting>
          )}
          {flow.state.connectorId === connector && flow.state.error && (
            <ConnectNote error>
              {connectErrorText(t, flow.state.error)}
            </ConnectNote>
          )}
          {connected ? (
            <Button size="lg" className={CONNECT_PRIMARY} onClick={close}>
              {t("phase5.done")}
            </Button>
          ) : waiting ? (
            <Button
              size="lg"
              variant="secondary"
              className={CONNECT_PRIMARY}
              onClick={() => void flow.cancel()}
            >
              {t("phase5.cancel")}
            </Button>
          ) : (
            <Button
              size="lg"
              className={CONNECT_PRIMARY}
              onClick={() => void flow.start(connector)}
            >
              {t(signIn ? "phase5.signIn" : "phase5.connect")}
            </Button>
          )}
          {connected && (
            <div className="flex justify-center">
              <ConfirmAction
                title={t("phase5.disconnectTitle", { name: entry?.name })}
                description={t("phase5.disconnectDescription")}
                label={t("phase5.disconnect")}
                onConfirm={async () => {
                  const result = await transport.client.connectors.disconnect({
                    connectorId: connector,
                  });
                  if (!result.ok) throw new Error(result.error);
                  close();
                }}
              />
            </div>
          )}
        </div>
      </ConnectDialogContent>
    </Dialog>
  );
};
const FieldForm = ({ connector }: { connector: string }) => {
  const { t } = useTranslation();
  const flow = useConnectFlow();
  const entry = connectorById(connector)!;
  const fields = connectFields(entry);
  const [error, setError] = useState<string | null>(null);
  const schema = v.record(
    v.string(),
    v.pipe(v.string(), v.trim(), v.minLength(1))
  );
  const form = useAppForm({
    defaultValues: Object.fromEntries(
      Object.keys(fields).map((key) => [key, ""])
    ),
    validationLogic: revalidateLogic({
      mode: "blur",
      modeAfterSubmission: "change",
    }),
    validators: { onDynamic: schema },
    onSubmit: async ({ value }) => {
      try {
        await flow.submit(v.parse(schema, value));
      } catch (e) {
        setError(e instanceof Error ? e.message : t("phase5.failed"));
      }
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void flow.cancel();
      }}
    >
      <ConnectDialogContent className="sm:max-w-[440px]">
        <ConnectHeader
          mark={<ConnectorMark id={entry.logo ?? entry.id} size={32} />}
          title={t("phase5.connectName", { name: entry.name })}
          description={t("phase5.credentialsLocal")}
        />
        <form
          className="flex min-w-0 flex-col gap-4 text-[15px] leading-[21px]"
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
        >
          <p className="text-muted-foreground">
            {t("phase5.credentialsLocal")}
          </p>
          <FieldGroup>
            {Object.entries(fields).map(([key, field]) => (
              <form.Field key={key} name={key}>
                {(f) => (
                  <Field>
                    <FieldLabel htmlFor={`connector-${key}`}>
                      {field.label}
                    </FieldLabel>
                    <Input
                      id={`connector-${key}`}
                      type={field.secret === false ? "text" : "password"}
                      value={f.state.value}
                      onChange={(e) => f.handleChange(e.target.value)}
                      onBlur={f.handleBlur}
                      aria-invalid={
                        f.state.meta.isBlurred && f.state.meta.errors.length > 0
                      }
                    />
                  </Field>
                )}
              </form.Field>
            ))}
            {entry.kind === "mcp" && entry.auth === "oauth-client" && (
              <code className="bg-muted self-start rounded-md px-1.5 py-0.5 font-mono text-xs">
                http://127.0.0.1:33418/callback
              </code>
            )}
          </FieldGroup>
          {error && (
            <ConnectNote error>{connectErrorText(t, error)}</ConnectNote>
          )}
          <form.AppForm>
            <form.SubmitButton
              label={t("phase5.connect")}
              className={CONNECT_PRIMARY}
            />
          </form.AppForm>
        </form>
      </ConnectDialogContent>
    </Dialog>
  );
};
export const ConnectorFieldsDialog = () => {
  const flow = useConnectFlow();
  return flow.state.phase === "fields" && flow.state.connectorId ? (
    <FieldForm
      key={flow.state.connectorId}
      connector={flow.state.connectorId}
    />
  ) : null;
};
