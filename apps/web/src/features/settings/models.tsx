import {
  PROVIDER_KEY_FIELDS,
  isPlausibleApiKey,
  type ProviderKeyField,
} from "@abacus-ai/contract/settings";
import { revalidateLogic } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { signInAbacus } from "#platform/sign-in";
import {
  ConnectorMark,
  markForProvider,
} from "#renderer/components/connector-mark";
import { useAppForm } from "#renderer/components/form-kit";
import { ConfirmAction } from "#renderer/components/form-kit/confirm";
import {
  ConnectNote,
  ConnectPending,
} from "#renderer/components/form-kit/connect-dialog";
import {
  AreaPage,
  GroupCard,
  PageNote,
  SettingRow,
  StatePill,
} from "#renderer/components/form-kit/page";
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { useMutation } from "#renderer/data/query-client";
import { connectErrorText } from "#renderer/lib/connect-page";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem } from "#renderer/lib/platform-system";
import { useAppContext, errorText } from "#renderer/lib/use-app-context";
import { useCreditsAccount } from "#renderer/lib/use-credits-account";
import { useNow } from "#renderer/lib/use-now";
import { useRowConnects } from "#renderer/lib/use-row-connects";
import { Button } from "#renderer/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#renderer/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "#renderer/ui/dialog";
import { Field, FieldLabel, FieldError } from "#renderer/ui/field";
import { Input } from "#renderer/ui/input";

import { creditMarkState } from "./credits";
export const ModelsPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const connects = useProviderConnects();
  const navigate = useAppNavigate();
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  const search = useSearch({ strict: false }) as { provider?: string };
  const keys = useQuery(
    transport.orpc.settings.keys.listProviders.queryOptions({ input: {} })
  );
  const account = useCreditsAccount();
  const [q, setQ] = useState("");
  const now = useNow();
  const mark = creditMarkState(
    account.data,
    prefs.creditsExhaustedAt,
    now,
    false
  );
  const fields = PROVIDER_KEY_FIELDS.filter((p) => p.kind === "model").toSorted(
    (a, b) => Number(!!b.featured) - Number(!!a.featured)
  );
  const row = (field: ProviderKeyField) => {
    const error = connects.rows.error(field.provider);
    return (
      <div key={field.provider}>
        <SettingRow
          id={`provider-${field.provider}`}
          media={
            <ConnectorMark
              id={markForProvider(field.provider) ?? field.provider}
              size={28}
            />
          }
          title={field.label}
          detail={
            keys.data?.includes(field.provider)
              ? t("phase5.savedUnverified")
              : field.envVar
          }
        >
          {connects.rows.waiting(field.provider) ? (
            <ConnectPending
              onCancel={() => connects.rows.cancel(field.provider)}
            />
          ) : (
            <>
              <StatePill>
                {t(
                  keys.data?.includes(field.provider)
                    ? "phase5.saved"
                    : "phase5.notConnected"
                )}
              </StatePill>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void navigate({
                    to: "/settings/models",
                    search: (old) => ({ ...old, provider: field.provider }),
                    transition: "none",
                  })
                }
              >
                {t(
                  keys.data?.includes(field.provider)
                    ? "phase5.manage"
                    : field.connect && IS_ELECTRON
                      ? "phase5.connect"
                      : "phase5.addKey"
                )}
              </Button>
            </>
          )}
        </SettingRow>
        {error != null && (
          <ConnectNote error className="px-3 pb-2.5">
            {connectErrorText(t, error)}
          </ConnectNote>
        )}
      </div>
    );
  };
  return (
    <>
      <AreaPage
        title={t("settings.pages.models")}
        description={t("phase5.settings.modelsDetail")}
      >
        {mark === "show" && (
          <GroupCard title={t("phase5.creditsExhausted")}>
            <p className="p-3 text-sm">{t("phase5.creditsAlternatives")}</p>
            <div className="flex gap-2 p-3">
              <Button
                onClick={() =>
                  void navigate({
                    to: "/settings/models",
                    search: (old) => ({ ...old, provider: "openrouter" }),
                    transition: "none",
                  })
                }
              >
                {t("phase5.connectFree")}
              </Button>
              <Button
                variant="ghost"
                onClick={() => void update({ creditsExhaustedAt: null })}
              >
                {t("phase5.dismiss")}
              </Button>
            </div>
          </GroupCard>
        )}
        <GroupCard title={t("phase5.providers")}>
          {fields.filter((p) => p.featured).map(row)}
        </GroupCard>
        <Collapsible className="flex flex-col gap-3">
          <CollapsibleTrigger className="group/c text-muted-foreground hover:text-foreground flex items-center gap-1.5 self-start text-[13px] font-medium">
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 transition-transform group-data-[panel-open]/c:rotate-90"
            />
            {t("phase5.otherProviders")}
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-3">
            <Input
              aria-label={t("phase5.searchProviders")}
              placeholder={t("phase5.searchProviders")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <GroupCard>
              {fields
                .filter(
                  (p) =>
                    !p.featured &&
                    [p.label, p.envVar, p.hint, p.provider]
                      .join(" ")
                      .toLowerCase()
                      .includes(q.toLowerCase())
                )
                .map(row)}
            </GroupCard>
          </CollapsibleContent>
        </Collapsible>
      </AreaPage>
      {search.provider &&
        fields.find((f) => f.provider === search.provider) && (
          <ProviderDialog
            key={search.provider}
            field={fields.find((f) => f.provider === search.provider)!}
            stored={keys.data?.includes(search.provider) ?? false}
            connects={connects}
          />
        )}
    </>
  );
};
/**
 * Sign-in providers' connects, owned by the page's rows: the dialog may close
 * while the browser waits, the row shows the wait with its Cancel, and leaving
 * the page cancels it.
 */
const useProviderConnects = () => {
  const { transport, credentialsChanged } = useAppContext();
  const navigate = useAppNavigate();
  const rows = useRowConnects();
  const start = (field: ProviderKeyField) => {
    const auth =
      field.connect === "abacus"
        ? transport.client.auth.abacus
        : transport.client.auth.openRouter;
    const cancel = () => {
      if (IS_ELECTRON) void auth.cancel({}).catch(() => undefined);
    };
    rows.start(field.provider, {
      run: () => (IS_ELECTRON ? auth.start({}) : signInAbacus(transport, {})),
      cancel,
      leave: cancel,
      connected: async () => {
        await transport.client.models.list({ refresh: true });
        await credentialsChanged();
        // Its dialog, if still open, has nothing left to do.
        await navigate({
          to: "/settings/models",
          search: (old) =>
            old.provider === field.provider
              ? { ...old, provider: undefined }
              : old,
          transition: "none",
        });
      },
    });
  };
  return { rows, start };
};

export const ProviderDialog = ({
  field,
  stored,
  connects,
}: {
  field: ProviderKeyField;
  stored: boolean;
  connects: ReturnType<typeof useProviderConnects>;
}) => {
  const { t } = useTranslation();
  const { transport, credentialsChanged } = useAppContext();
  const navigate = useAppNavigate();
  const [error, setError] = useState<string | null>(null);
  const close = () =>
    void navigate({
      to: "/settings/models",
      search: (old) => ({ ...old, provider: undefined }),
      transition: "none",
    });
  const canConnect =
    field.connect && (IS_ELECTRON || field.connect === "abacus");
  const waiting = connects.rows.waiting(field.provider);
  const connectError = connects.rows.error(field.provider);
  const refresh = async () => {
    await transport.client.models.list({ refresh: true });
    await credentialsChanged();
  };
  const saveKey = useMutation(
    transport.orpc.settings.keys.save.mutationOptions({
      onSuccess: async () => {
        await refresh();
        close();
      },
    })
  );
  const save = (key: string) =>
    saveKey.mutateAsync({ provider: field.provider, key });
  const schema = v.object({
    key: v.pipe(v.string(), v.trim(), v.check(isPlausibleApiKey, "api-key")),
  });
  const form = useAppForm({
    defaultValues: { key: "" },
    validationLogic: revalidateLogic({
      mode: "blur",
      modeAfterSubmission: "change",
    }),
    validators: { onDynamic: schema },
    onSubmit: async ({ value }) => {
      try {
        await save(v.parse(schema, value).key);
      } catch (e) {
        setError(errorText(e));
      }
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            {t(canConnect ? "phase5.connectProvider" : "phase5.getKey", {
              provider: field.label,
            })}
          </DialogTitle>
          <DialogDescription>{t("phase5.storedHere")}</DialogDescription>
        </DialogHeader>
        {canConnect ? (
          <div className="flex flex-col gap-2">
            {waiting ? (
              <ConnectPending
                className="self-start"
                onCancel={() => connects.rows.cancel(field.provider)}
              />
            ) : (
              <Button
                className="self-start"
                onClick={() => connects.start(field)}
              >
                {t("phase5.connect")}
              </Button>
            )}
            {connectError != null && (
              <ConnectNote error>
                {connectErrorText(t, connectError)}
              </ConnectNote>
            )}
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
            className="space-y-3"
          >
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                void platformSystem(transport.client).openExternal({
                  url: field.signupUrl,
                })
              }
            >
              {t("phase5.openProvider", { provider: field.label })}
            </Button>
            <form.Field name="key">
              {(f) => (
                <Field>
                  <FieldLabel htmlFor="provider-key">
                    {t("phase5.apiKey")}
                  </FieldLabel>
                  <Input
                    autoFocus
                    id="provider-key"
                    type="password"
                    value={f.state.value}
                    onChange={(e) => f.handleChange(e.target.value)}
                    onBlur={f.handleBlur}
                  />
                  {f.state.meta.errors.length > 0 && (
                    <FieldError>{t("phase5.invalidKey")}</FieldError>
                  )}
                </Field>
              )}
            </form.Field>
            <form.AppForm>
              <form.SubmitButton label={t("phase5.save")} />
            </form.AppForm>
          </form>
        )}
        {error && <PageNote error>{error}</PageNote>}
        <DialogFooter>
          {stored && (
            <ConfirmAction
              title={t("phase5.removeKey", { provider: field.label })}
              description={t("phase5.removeKeyDetail")}
              label={t("phase5.remove")}
              onConfirm={() => save("")}
            />
          )}
          <Button variant="secondary" onClick={close}>
            {t("phase5.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
