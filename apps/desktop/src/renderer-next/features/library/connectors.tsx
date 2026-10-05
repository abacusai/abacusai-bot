import {
  CONNECTORS,
  connectorById,
  type Connector,
} from "@abacus-ai/connectors/registry";
import { revalidateLogic } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { ConnectorMark } from "#next/components/connector-mark";
import { useAppForm } from "#next/components/form-kit";
import { ConfirmAction } from "#next/components/form-kit/confirm";
import { Segments } from "#next/components/form-kit/controls";
import {
  AreaPage,
  GroupCard,
  SettingRow,
  StatePill,
} from "#next/components/form-kit/page";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { useAppContext, foldSearch } from "#next/lib/use-app-context";
import { Button } from "#next/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "#next/ui/dialog";
import { Field, FieldLabel, FieldGroup } from "#next/ui/field";
import { Input } from "#next/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "#next/ui/sheet";

import { fieldsFor, useConnectFlow } from "./connect-flow";
import { CONNECTOR_CATEGORY_TABS } from "./search";
export const visibleTabsFor = (entry: Connector): string[] =>
  entry.kind === "messaging"
    ? []
    : entry.category === "abacus-connectors"
      ? entry.onboarding
        ? ["abacus", "featured"]
        : ["abacus"]
      : [entry.category];
export const ConnectorsPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const search = useSearch({ strict: false }) as {
    category?: string;
    q?: string;
  };
  const navigate = useAppNavigate();
  const flow = useConnectFlow();
  const statuses = useQuery({
    ...transport.orpc.connectors.statuses.queryOptions({ input: {} }),
    staleTime: 60000,
  });
  const entries = CONNECTORS.filter(
    (e) =>
      e.kind !== "messaging" &&
      statuses.data?.[e.id]?.reason !== "not-offered" &&
      (search.q
        ? foldSearch(e.name + " " + e.description).includes(
            foldSearch(search.q)
          )
        : visibleTabsFor(e).includes(search.category ?? "featured"))
  );
  const connected = (id: string) =>
    ["connected", "pending"].includes(statuses.data?.[id]?.state ?? "");
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
      {flow.state.chromeMissing && (
        <p role="status">
          {t("connectors.chromeMissing", {
            name: connectorById(flow.state.connectorId ?? "")?.name,
          })}
        </p>
      )}
      {!search.q && (
        <Segments
          label={t("phase5.category")}
          value={search.category ?? "featured"}
          values={CONNECTOR_CATEGORY_TABS.map((value) => ({
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
      {[true, false].map((group) => (
        <section key={String(group)}>
          <h2 className="mb-2 text-sm font-semibold">
            {t(group ? "phase5.connected" : "phase5.available")}
          </h2>
          <GroupCard>
            {entries
              .filter((e) => connected(e.id) === group)
              .map((e) => (
                <SettingRow
                  key={e.id}
                  id={e.id}
                  title={e.name}
                  detail={statuses.data?.[e.id]?.account ?? e.description}
                >
                  <ConnectorMark id={e.logo ?? e.id} size={28} />
                  <StatePill>
                    {t(group ? "phase5.connected" : "phase5.available")}
                  </StatePill>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      if (group)
                        void navigate({
                          to: "/library/connectors",
                          search: (p) => ({ ...p, connector: e.id }),
                          transition: "none",
                        });
                      else void flow.start(e.id);
                    }}
                  >
                    {t(group ? "phase5.manage" : "phase5.add")}
                  </Button>
                </SettingRow>
              ))}
          </GroupCard>
        </section>
      ))}
      {flow.state.phase !== "idle" && (
        <p aria-live="polite">
          {t("phase5.connectWaiting")}
          <Button size="sm" variant="ghost" onClick={() => void flow.cancel()}>
            {t("phase5.cancel")}
          </Button>
        </p>
      )}
      {flow.state.error && <p role="alert">{flow.state.error}</p>}
    </AreaPage>
  );
};
export const ConnectorSheet = ({ connector }: { connector: string }) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const flow = useConnectFlow();
  const navigate = useAppNavigate();
  const entry = connectorById(connector);
  const statuses = useQuery(
    transport.orpc.connectors.statuses.queryOptions({ input: {} })
  );
  const close = () =>
    void navigate({
      to: "/library/connectors",
      search: (p) => ({ ...p, connector: undefined }),
      transition: "none",
    });
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <SheetContent data-testid="connector-sheet" className="sm:max-w-[420px]">
        <SheetHeader>
          <SheetTitle>{entry?.name ?? connector}</SheetTitle>
          <SheetDescription>{entry?.description}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-auto p-4">
          <ConnectorMark id={entry?.logo ?? connector} size={40} />
          <StatePill>
            {statuses.data?.[connector]?.account ??
              statuses.data?.[connector]?.state}
          </StatePill>
          <h2>{t("phase5.whatItCanDo")}</h2>
          {entry?.kind === "platform" ? (
            entry.tools.map((tool) => <code key={tool}>{tool}</code>)
          ) : entry?.kind === "credential" ? (
            <code>{entry.envVar}</code>
          ) : entry?.kind === "mcp" ? (
            <code>{entry.entry.url ?? entry.entry.command}</code>
          ) : null}
          {entry?.setup?.map((step) => (
            <p key={step}>{step}</p>
          ))}
          <Button
            variant="secondary"
            onClick={() =>
              entry &&
              void transport.client.system.openExternal({ url: entry.docsUrl })
            }
          >
            {t("phase5.documentation")}
          </Button>
          <Button onClick={() => void flow.start(connector)}>
            {t("phase5.connect")}
          </Button>
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
          <Button variant="secondary" onClick={close}>
            {t("phase5.done")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
};
const FieldForm = ({ connector }: { connector: string }) => {
  const { t } = useTranslation();
  const flow = useConnectFlow();
  const entry = connectorById(connector)!;
  const fields = fieldsFor(entry);
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
      } catch {
        setError(t("phase5.failed"));
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
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {t("phase5.connectName", { name: entry.name })}
          </DialogTitle>
          <DialogDescription>{t("phase5.credentialsLocal")}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
        >
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
              <code>http://127.0.0.1:33418/callback</code>
            )}
            {error && <p role="alert">{error}</p>}
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void flow.cancel()}
              >
                {t("phase5.cancel")}
              </Button>
              <form.AppForm>
                <form.SubmitButton label={t("phase5.connect")} />
              </form.AppForm>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
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
