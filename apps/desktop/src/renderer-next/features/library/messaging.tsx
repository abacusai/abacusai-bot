import { useLiveQuery } from "@tanstack/react-db";
import { revalidateLogic } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { ConnectorMark } from "#next/components/connector-mark";
import { useAppForm } from "#next/components/form-kit";
import { ConfirmAction } from "#next/components/form-kit/confirm";
import { SettingSwitch, Choice } from "#next/components/form-kit/controls";
import {
  AreaPage,
  GroupCard,
  SettingRow,
  StatePill,
} from "#next/components/form-kit/page";
import { useCollections } from "#next/data/db";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { showError } from "#next/lib/toast";
import { useAppContext } from "#next/lib/use-app-context";
import { Button } from "#next/ui/button";
import { Field, FieldGroup, FieldLabel, FieldError } from "#next/ui/field";
import { Input } from "#next/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "#next/ui/sheet";
import {
  SHARED_BOT_PLATFORM_OF,
  SHARED_LINK_REQUIRED,
  type MessagingPlatformId,
  type MessagingPlatformInfo,
  type UpdateMessagingSettingsRequest,
} from "#shared/messaging";

import {
  connectPlatform,
  disablePlatform,
  useConnectFlow,
} from "./connect-flow";
export const MessagingPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const c = useCollections();
  const bots = useLiveQuery(c.bots).data ?? [];
  const workspaces = useLiveQuery(c.workspaces).data ?? [];
  const query = useQuery(
    transport.orpc.messaging.snapshot.queryOptions({ input: {} })
  );
  const s = query.data;
  const navigate = useAppNavigate();
  const update = async (patch: UpdateMessagingSettingsRequest) => {
    if (!s) return;
    cache.setQueryData(
      transport.orpc.messaging.snapshot.queryKey({ input: {} }),
      { ...s, ...patch }
    );
    try {
      const next = await transport.client.messaging.updateSettings(patch);
      cache.setQueryData(
        transport.orpc.messaging.snapshot.queryKey({ input: {} }),
        next
      );
    } catch {
      cache.setQueryData(
        transport.orpc.messaging.snapshot.queryKey({ input: {} }),
        s
      );
      showError(t("phase5.failed"));
    }
  };
  return (
    <AreaPage
      title={t("library.pages.messaging")}
      description={t("phase5.messagingDescription")}
    >
      <GroupCard>
        {s?.platforms
          .filter((p) => ["whatsapp", "telegram", "discord"].includes(p.id))
          .map((p) => (
            <SettingRow
              key={p.id}
              id={p.id}
              title={t(`messaging.platforms.${p.nameKey}`)}
              detail={p.errorMessage ?? t(`messaging.states.${p.state}`)}
            >
              <ConnectorMark id={p.id} size={28} />
              <StatePill>{p.state}</StatePill>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void navigate({
                    to: "/library/messaging",
                    search: { platform: p.id },
                    transition: "none",
                  })
                }
              >
                {t(
                  p.state === "connected" ? "phase5.manage" : "phase5.connect"
                )}
              </Button>
            </SettingRow>
          ))}
      </GroupCard>
      {s && (
        <GroupCard>
          {(
            [
              ["gatewayEnabled", "phase5.messagingEnabled"],
              ["respondToInbound", "phase5.respondInbound"],
              ["autoApproveTools", "phase5.remoteUnattended"],
            ] as const
          ).map(([id, key]) => (
            <SettingRow
              key={id}
              id={id}
              title={t(key)}
              detail={
                id === "autoApproveTools"
                  ? t("phase5.remoteWarning")
                  : undefined
              }
            >
              <SettingSwitch
                id={id}
                checked={s[id]}
                onCheckedChange={(value) => void update({ [id]: value })}
              />
            </SettingRow>
          ))}
          <SettingRow id="messagingWorkspace" title={t("phase5.folder")}>
            <Choice
              id="messagingWorkspace"
              value={s.workspaceId ?? ""}
              options={[
                { value: "", label: t("phase5.followWorkspace") },
                ...workspaces
                  .filter((w) => w.kind == null || w.kind === "auto")
                  .map((w) => ({ value: w.id, label: w.label ?? w.path })),
              ]}
              onChange={(workspaceId) =>
                void update({ workspaceId: workspaceId || null })
              }
            />
          </SettingRow>
          <SettingRow id="messagingBot" title={t("phase5.deliverToBot")}>
            <Choice
              id="messagingBot"
              value={s.botId ?? ""}
              options={[
                { value: "", label: t("phase5.noBot") },
                ...bots.map((b) => ({ value: b.id, label: b.name })),
              ]}
              onChange={(botId) => void update({ botId: botId || null })}
            />
          </SettingRow>
        </GroupCard>
      )}
      <PlatformSheet />
    </AreaPage>
  );
};
const PlatformSheet = () => {
  const search = useSearch({ strict: false }) as {
    platform?: MessagingPlatformId;
  };
  return search.platform ? (
    <PlatformDetail key={search.platform} platform={search.platform} />
  ) : null;
};
const PlatformDetail = ({ platform }: { platform: MessagingPlatformId }) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const query = useQuery(
    transport.orpc.messaging.snapshot.queryOptions({ input: {} })
  );
  const s = query.data;
  const p = s?.platforms.find((p) => p.id === platform);
  const sharedId = SHARED_BOT_PLATFORM_OF[platform];
  const shared = s?.platforms.find((p) => p.id === sharedId);
  const navigate = useAppNavigate();
  const flow = useConnectFlow();
  const flowRef = useRef(flow);
  useEffect(() => {
    flowRef.current = flow;
  }, [flow]);
  const [error, setError] = useState<string | null>(null);
  const apply = async (promise: Promise<NonNullable<typeof s>>) => {
    const next = await promise;
    cache.setQueryData(
      transport.orpc.messaging.snapshot.queryKey({ input: {} }),
      next
    );
  };
  const close = async () => {
    await flow.settlePairing(platform);
    await navigate({
      to: "/library/messaging",
      search: { platform: undefined },
      transition: "none",
    });
  };
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        await connectPlatform({ transport, queryClient: cache }, platform);
        if (!live) return;
        await transport.client.messaging.showLogin({ platformId: platform });
        if (sharedId && SHARED_LINK_REQUIRED.has(platform)) {
          await connectPlatform({ transport, queryClient: cache }, sharedId);
          const next = await transport.client.messaging.pairShared({
            platformId: sharedId,
          });
          cache.setQueryData(
            transport.orpc.messaging.snapshot.queryKey({ input: {} }),
            next
          );
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : t("phase5.failed"));
      }
    })();
    return () => {
      live = false;
      void flowRef.current.settlePairing(platform);
    };
  }, [platform, transport, cache, sharedId, t]);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <SheetContent className="sm:max-w-[480px]">
        <SheetHeader>
          <SheetTitle>
            {t(`messaging.platforms.${p?.nameKey ?? platform}`)}
          </SheetTitle>
          <SheetDescription>
            {t("phase5.messagingDescription")}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 overflow-auto p-4">
          <StatePill>{p?.state}</StatePill>
          {(error || p?.errorMessage) && (
            <p role="alert">{error ?? p?.errorMessage}</p>
          )}
          <Button
            variant="secondary"
            onClick={() =>
              void transport.client.messaging.showLogin({
                platformId: platform,
              })
            }
          >
            {t("phase5.openLogin")}
          </Button>
          {p && p.fields.length > 0 && <PlatformCredentials platform={p} />}
          {shared?.sharedLink && (
            <>
              {shared.sharedLink.qrDataUrl && (
                <img
                  className="size-[180px]"
                  src={shared.sharedLink.qrDataUrl}
                  alt={t("phase5.linkQr")}
                />
              )}
              <code>/link {shared.sharedLink.code}</code>
              <Button
                onClick={() =>
                  void navigator.clipboard.writeText(
                    `/link ${shared.sharedLink?.code}`
                  )
                }
              >
                {t("phase5.copy")}
              </Button>
              {sharedId && (
                <>
                  <Button
                    onClick={() =>
                      void transport.client.messaging.openSharedLink({
                        platformId: sharedId,
                        target: "install",
                      })
                    }
                  >
                    {t("phase5.addDiscord")}
                  </Button>
                  <Button
                    onClick={() =>
                      void transport.client.messaging.openSharedLink({
                        platformId: sharedId,
                        target: "dm",
                      })
                    }
                  >
                    {t("phase5.openSharedChat")}
                  </Button>
                </>
              )}
            </>
          )}
          {s?.pending
            .filter((u) => u.platform === platform)
            .map((u) => (
              <SettingRow
                key={u.userId}
                id={u.userId}
                title={u.userName ?? u.userId}
                detail={u.firstMessage ?? ""}
              >
                {(["approve", "revoke"] as const).map((decision) => (
                  <Button
                    key={decision}
                    size="sm"
                    onClick={() =>
                      void apply(
                        transport.client.messaging.decidePairing({
                          platformId: platform,
                          userId: u.userId,
                          decision,
                        })
                      )
                    }
                  >
                    {t(
                      decision === "approve"
                        ? "phase5.approve"
                        : "phase5.reject"
                    )}
                  </Button>
                ))}
              </SettingRow>
            ))}
          {s?.autoReplies
            .filter((u) => u.platform === platform)
            .map((u) => (
              <SettingRow
                key={u.userId}
                id={u.userId}
                title={u.userName ?? u.userId}
                detail={u.status}
              >
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void apply(
                      transport.client.messaging.decidePairing({
                        platformId: platform,
                        userId: u.userId,
                        decision: u.status === "paused" ? "resume" : "pause",
                      })
                    )
                  }
                >
                  {t(u.status === "paused" ? "phase5.resume" : "phase5.pause")}
                </Button>
                <ConfirmAction
                  title={t("phase5.revokeTitle")}
                  description={t("phase5.revokeDescription")}
                  label={t("phase5.revoke")}
                  onConfirm={() =>
                    apply(
                      transport.client.messaging.decidePairing({
                        platformId: platform,
                        userId: u.userId,
                        decision: "revoke",
                      })
                    )
                  }
                />
              </SettingRow>
            ))}
          <ConfirmAction
            title={t("phase5.unlinkTitle")}
            description={t("phase5.unlinkDescription")}
            label={t("phase5.unlink")}
            onConfirm={() =>
              disablePlatform({ transport, queryClient: cache }, platform)
            }
          />
          <Button variant="secondary" onClick={() => void close()}>
            {t("phase5.done")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
};

const PlatformCredentials = ({
  platform,
}: {
  platform: MessagingPlatformInfo;
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const schema = v.object(
    Object.fromEntries(
      platform.fields.map((field) => [
        field.key,
        v.pipe(
          v.string(),
          v.trim(),
          v.check(
            (value) => !field.required || field.isSet || value.length > 0,
            "required"
          )
        ),
      ])
    )
  );
  const form = useAppForm({
    defaultValues: Object.fromEntries(
      platform.fields.map((field) => [field.key, ""])
    ),
    validationLogic: revalidateLogic({
      mode: "blur",
      modeAfterSubmission: "change",
    }),
    validators: { onDynamic: schema },
    onSubmit: async ({ value }) => {
      try {
        const values = Object.fromEntries(
          Object.entries(v.parse(schema, value)).filter(
            ([, value]) => value !== ""
          )
        );
        const snapshot = await transport.client.messaging.updatePlatform({
          platformId: platform.id,
          values,
        });
        cache.setQueryData(
          transport.orpc.messaging.snapshot.queryKey({ input: {} }),
          snapshot
        );
        form.reset();
      } catch {
        showError(t("phase5.saveFailed"));
      }
    },
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <FieldGroup>
        {platform.fields.map((field) => (
          <form.Field key={field.key} name={field.key}>
            {(f) => (
              <Field data-invalid={f.state.meta.errors.length > 0}>
                <FieldLabel htmlFor={`messaging-${field.key}`}>
                  {t(`messaging.fields.${field.labelKey}`, {
                    defaultValue: field.key,
                  })}
                </FieldLabel>
                <Input
                  id={`messaging-${field.key}`}
                  type={field.secret ? "password" : "text"}
                  value={f.state.value}
                  placeholder={field.redactedValue ?? ""}
                  disabled={field.fromEnv}
                  aria-invalid={f.state.meta.errors.length > 0}
                  onChange={(event) => f.handleChange(event.target.value)}
                  onBlur={f.handleBlur}
                />
                {f.state.meta.errors.length > 0 && (
                  <FieldError>{t("messaging.required")}</FieldError>
                )}
              </Field>
            )}
          </form.Field>
        ))}
        <form.AppForm>
          <form.SubmitButton label={t("phase5.save")} />
        </form.AppForm>
      </FieldGroup>
    </form>
  );
};
