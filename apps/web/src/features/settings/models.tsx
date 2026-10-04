import { localModelReference } from "@abacus-ai/contract/local-models";
import {
  PROVIDER_KEY_FIELDS,
  isPlausibleApiKey,
  type ProviderKeyField,
} from "@abacus-ai/contract/settings";
import { revalidateLogic } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
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
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { followNotices } from "#renderer/data/queries/live";
import { webSignIn } from "#renderer/lib/browser/sign-in";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem } from "#renderer/lib/platform-system";
import { useAppContext, errorText } from "#renderer/lib/use-app-context";
import { useNow } from "#renderer/lib/use-now";
import { Button } from "#renderer/ui/button";
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
export const ModelsPage = ({
  adoptModel,
}: {
  adoptModel?: (target: string, model: string) => Promise<void>;
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const navigate = useAppNavigate();
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  const search = useSearch({ strict: false }) as {
    provider?: string;
    for?: string;
  };
  const keys = useQuery(
    transport.orpc.settings.keys.listProviders.queryOptions({ input: {} })
  );
  const account = useQuery({
    ...transport.orpc.account.abacus.queryOptions({ input: { refresh: true } }),
    queryKey: [
      ...transport.orpc.account.abacus.queryKey({ input: { refresh: true } }),
      prefs.creditsExhaustedAt,
    ],
    staleTime: 60000,
    refetchInterval: 300000,
  });
  const state = useQuery(
    transport.orpc.localModels.state.queryOptions({
      input: {},
      enabled: IS_ELECTRON,
    })
  );
  const [q, setQ] = useState("");
  const installGeneration = useRef(0);
  useEffect(
    () => () => {
      installGeneration.current++;
    },
    [search.for]
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();
  const mark = creditMarkState(
    account.data,
    prefs.creditsExhaustedAt,
    now,
    account.dataUpdatedAt >= (prefs.creditsExhaustedAt ?? Infinity)
  );
  useEffect(() => {
    if (mark === "clear")
      void update({ creditsExhaustedAt: null }).catch(() => undefined);
  }, [mark, update]);
  useEffect(() => {
    if (!IS_ELECTRON) return;
    const abort = new AbortController();
    void followNotices(
      transport,
      ({ signal }) => transport.client.localModels.progress({}, { signal }),
      (progress) => {
        cache.setQueryData(
          transport.orpc.localModels.state.queryKey({ input: {} }),
          (old) => (old ? { ...old, download: progress } : old)
        );
        if (["ready", "failed", "cancelled"].includes(progress.phase)) {
          void cache.invalidateQueries({
            queryKey: transport.orpc.localModels.state.queryKey({ input: {} }),
          });
          void cache.invalidateQueries({
            queryKey: transport.orpc.models.list.queryKey(),
          });
        }
      },
      abort.signal
    );
    return () => abort.abort();
  }, [transport, cache]);
  useEffect(() => {
    if (search.provider === "local") {
      const el = document.querySelector<HTMLElement>(
        '[data-setting-id="localModels"]'
      );
      el?.scrollIntoView({ block: "center" });
      el?.querySelector<HTMLElement>("button")?.focus();
    }
  }, [search.provider, state.data?.runtimeAvailable]);
  const adopt = async (id: string) => {
    if (search.for && adoptModel)
      await adoptModel(search.for, localModelReference(id));
  };
  const install = async (id: string) => {
    const generation = ++installGeneration.current;
    setBusy(id);
    setError(null);
    try {
      const result = await transport.client.localModels.install({
        modelId: id,
      });
      if (generation !== installGeneration.current) return;
      if (result.ok) {
        await cache.invalidateQueries({
          queryKey: transport.orpc.localModels.state.queryKey({ input: {} }),
        });
        await cache.invalidateQueries({
          queryKey: transport.orpc.models.list.queryKey(),
        });
        await adopt(id);
      } else if (result.error !== "cancelled") setError(result.error);
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(null);
  };
  const fields = PROVIDER_KEY_FIELDS.filter((p) => p.kind === "model").toSorted(
    (a, b) => Number(!!b.featured) - Number(!!a.featured)
  );
  const row = (field: ProviderKeyField) => (
    <SettingRow
      id={`provider-${field.provider}`}
      key={field.provider}
      title={field.label}
      detail={
        keys.data?.includes(field.provider)
          ? t("phase5.savedUnverified")
          : field.envVar
      }
    >
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
    </SettingRow>
  );
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
                variant="secondary"
                onClick={() =>
                  void navigate({
                    to: "/settings/models",
                    search: (old) => ({ ...old, provider: "local" }),
                    transition: "none",
                  })
                }
              >
                {t("phase5.useLocal")}
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
        <details>
          <summary>{t("phase5.otherProviders")}</summary>
          <Input
            aria-label={t("phase5.searchProviders")}
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
        </details>
        {IS_ELECTRON && state.data?.runtimeAvailable && (
          <section data-setting-id="localModels">
            <GroupCard title={t("phase5.onThisMachine")}>
              <p className="p-3 text-xs">
                {t("phase5.memoryAvailable", {
                  memory: Math.round(state.data.totalMemoryBytes / 1024 ** 3),
                })}
              </p>
              {state.data.catalog.map((model) => {
                const installed = state.data!.installedIds.includes(model.id);
                const progress =
                  state.data!.download?.modelId === model.id
                    ? state.data!.download
                    : null;
                const downloading =
                  progress?.phase === "downloading" ||
                  progress?.phase === "verifying";
                return (
                  <SettingRow
                    id={`local-${model.id}`}
                    key={model.id}
                    title={model.label}
                    detail={[
                      model.id === state.data!.recommendedId
                        ? t("phase5.recommended")
                        : "",
                      `${(model.sizeBytes / 1024 ** 3).toFixed(1)} GB`,
                      model.minMemoryBytes > state.data!.totalMemoryBytes
                        ? t("phase5.tightMemory")
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  >
                    {installed ? (
                      <>
                        <StatePill>{t("phase5.installed")}</StatePill>
                        {search.for && (
                          <Button
                            disabled={!adoptModel}
                            size="sm"
                            onClick={() =>
                              void adopt(model.id).catch((e) =>
                                setError(errorText(e))
                              )
                            }
                          >
                            {t("phase5.useModel", { model: model.label })}
                          </Button>
                        )}
                        <ConfirmAction
                          title={t("phase5.removeModel", {
                            model: model.label,
                          })}
                          description={t("phase5.downloadAgain")}
                          label={t("phase5.remove")}
                          onConfirm={async () => {
                            await transport.client.localModels.remove({
                              modelId: model.id,
                            });
                            await cache.invalidateQueries({
                              queryKey:
                                transport.orpc.localModels.state.queryKey({
                                  input: {},
                                }),
                            });
                          }}
                        />
                      </>
                    ) : downloading ? (
                      <>
                        <span role="status" className="text-xs">
                          {progress.phase === "verifying"
                            ? t("phase5.verifying")
                            : `${Math.round((progress.receivedBytes / Math.max(1, progress.totalBytes)) * 100)}%`}
                        </span>
                        <Button
                          size="sm"
                          onClick={() =>
                            void transport.client.localModels.cancelInstall({})
                          }
                        >
                          {t("phase5.stop")}
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        disabled={
                          busy !== null ||
                          ["downloading", "verifying"].includes(
                            state.data!.download?.phase ?? ""
                          )
                        }
                        onClick={() => void install(model.id)}
                      >
                        {t(
                          search.for ? "phase5.installUse" : "phase5.download"
                        )}
                      </Button>
                    )}
                  </SettingRow>
                );
              })}
            </GroupCard>
          </section>
        )}
        {error && <p role="alert">{error}</p>}
      </AreaPage>
      {search.provider &&
        search.provider !== "local" &&
        fields.find((f) => f.provider === search.provider) && (
          <ProviderDialog
            key={search.provider}
            field={fields.find((f) => f.provider === search.provider)!}
            stored={keys.data?.includes(search.provider) ?? false}
          />
        )}
    </>
  );
};
export const ProviderDialog = ({
  field,
  stored,
}: {
  field: ProviderKeyField;
  stored: boolean;
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const navigate = useAppNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);
  const close = () =>
    void navigate({
      to: "/settings/models",
      search: (old) => ({ ...old, provider: undefined }),
      transition: "none",
    });
  const canConnect =
    field.connect && (IS_ELECTRON || field.connect === "abacus");
  const auth =
    field.connect === "abacus"
      ? transport.client.auth.abacus
      : transport.client.auth.openRouter;
  useEffect(
    () => () => {
      token.current++;
      if (IS_ELECTRON && field.connect) void auth.cancel({});
    },
    [auth, field.connect]
  );
  const refresh = async () => {
    await transport.client.models.list({ refresh: true });
    await Promise.all([
      cache.invalidateQueries({
        queryKey: transport.orpc.settings.keys.listProviders.queryKey({
          input: {},
        }),
      }),
      cache.invalidateQueries({
        queryKey: transport.orpc.models.list.queryKey(),
      }),
    ]);
  };
  const save = async (key: string) => {
    await transport.client.settings.keys.save({
      provider: field.provider,
      key,
    });
    await refresh();
    close();
  };
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
  const connect = async () => {
    if (!canConnect) return;
    const id = ++token.current;
    setPending(true);
    setError(null);
    try {
      const result = IS_ELECTRON
        ? await auth.start({})
        : await webSignIn(transport);
      if (id !== token.current) return;
      if (result.ok) {
        await refresh();
        close();
      } else if (!result.cancelled) setError(result.error);
    } catch (e) {
      if (id === token.current) setError(errorText(e));
    }
    if (id === token.current) setPending(false);
  };
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
          <div className="flex gap-2">
            <Button disabled={pending} onClick={() => void connect()}>
              {t(pending ? "phase5.waitingSignIn" : "phase5.connect")}
            </Button>
            {pending && (
              <Button
                variant="secondary"
                onClick={() => {
                  token.current++;
                  setPending(false);
                  if (IS_ELECTRON) void auth.cancel({});
                }}
              >
                {t("phase5.cancel")}
              </Button>
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
        {error && <p role="alert">{error}</p>}
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
