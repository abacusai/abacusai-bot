import {
  SHARED_BOT_PLATFORM_OF,
  SHARED_LINK_REQUIRED,
  type MessagingPlatformId,
  type MessagingPlatformInfo,
  type MessagingSnapshot,
  type UpdateMessagingSettingsRequest,
} from "@abacus-ai/contract/messaging";
import { useLiveQuery } from "@tanstack/react-db";
import { revalidateLogic } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { WebMessagingPage } from "#platform/whatsapp-phone";
import { ConnectorMark } from "#renderer/components/connector-mark";
import { useAppForm } from "#renderer/components/form-kit";
import { ConfirmAction } from "#renderer/components/form-kit/confirm";
import { ConnectDialogContent } from "#renderer/components/form-kit/connect-dialog";
import { SettingSwitch, Choice } from "#renderer/components/form-kit/controls";
import {
  AreaPage,
  GroupCard,
  SettingRow,
  StatePill,
} from "#renderer/components/form-kit/page";
import { useCollections } from "#renderer/data/db";
import {
  optimistic,
  useMutation,
  useMutationState,
} from "#renderer/data/query-client";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { showError } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "#renderer/ui/dialog";
import { Field, FieldGroup, FieldLabel, FieldError } from "#renderer/ui/field";
import { Input } from "#renderer/ui/input";

import {
  connectPlatform,
  disablePlatform,
  useConnectFlow,
} from "./connect-flow";
import { useMessagingDialog } from "./messaging-dialog";
export const MessagingPage = () =>
  IS_ELECTRON ? <DesktopMessagingPage /> : <WebMessagingPage />;
const DesktopMessagingPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const c = useCollections();
  const bots = useLiveQuery(c.bots).data ?? [];
  const workspaces = useLiveQuery(c.workspaces).data ?? [];
  const query = useQuery(
    transport.orpc.messaging.snapshot.queryOptions({ input: {} })
  );
  const s = query.data;
  const dialog = useMessagingDialog();
  const settings = useMutation(
    transport.orpc.messaging.updateSettings.mutationOptions({
      ...optimistic(
        transport.orpc.messaging.snapshot.queryKey({ input: {} }),
        (old, patch: UpdateMessagingSettingsRequest) => ({ ...old, ...patch })
      ),
      meta: { errorToast: "phase5.failed" },
    })
  );
  const update = (patch: UpdateMessagingSettingsRequest) =>
    settings.mutate(patch);
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
              detail={p.errorMessage ?? undefined}
            >
              <ConnectorMark id={p.id} size={36} />
              <StatePill>{t(`messaging.states.${p.state}`)}</StatePill>
              <Button
                size="sm"
                variant="secondary"
                data-messaging-channel={p.id}
                onClick={() => void dialog.open(p.id)}
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
                onCheckedChange={(value) => update({ [id]: value })}
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
                update({ workspaceId: workspaceId || null })
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
              onChange={(botId) => update({ botId: botId || null })}
            />
          </SettingRow>
        </GroupCard>
      )}
      <PlatformDialog />
    </AreaPage>
  );
};
/** A messaging write answers with the whole new snapshot. */
const useWritesSnapshot = () => {
  const { transport } = useAppContext();
  const cache = useQueryClient();
  return {
    onSuccess: (next: MessagingSnapshot) =>
      cache.setQueryData(
        transport.orpc.messaging.snapshot.queryKey({ input: {} }),
        next
      ),
  };
};
const PlatformDialog = () => {
  const { platform } = useMessagingDialog();
  return platform ? (
    <PlatformDetail key={platform} platform={platform} />
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
  const dialog = useMessagingDialog();
  const flow = useConnectFlow();
  const flowRef = useRef(flow);
  useEffect(() => {
    flowRef.current = flow;
  }, [flow]);
  const [error, setError] = useState<string | null>(null);
  const writesSnapshot = useWritesSnapshot();
  const decide = useMutation(
    transport.orpc.messaging.decidePairing.mutationOptions(writesSnapshot)
  );
  // Per sender: deciding one leaves the others' buttons usable.
  const deciding = useMutationState({
    filters: {
      mutationKey: transport.orpc.messaging.decidePairing.mutationKey(),
      status: "pending",
    },
    select: (mutation) =>
      (mutation.state.variables as { userId: string }).userId,
  });
  const unlinkShared = useMutation(
    transport.orpc.messaging.unlinkShared.mutationOptions(writesSnapshot)
  );
  const close = async () => {
    try {
      await flow.settlePairing(platform);
      await dialog.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("phase5.failed"));
    }
  };
  useEffect(() => {
    let live = true;
    const ready = flowRef.current.registerPairing(platform, async () => {
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
    });
    void ready.catch((e) => {
      if (live) setError(e instanceof Error ? e.message : t("phase5.failed"));
    });
    return () => {
      live = false;
      void flowRef.current.settlePairing(platform).catch((e) => {
        if (transport.state !== "closed")
          showError(e instanceof Error ? e.message : t("phase5.failed"));
      });
    };
  }, [platform, transport, cache, sharedId, t]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <ConnectDialogContent
        className="sm:max-w-[480px]"
        finalFocus={dialog.finalFocus}
      >
        <DialogHeader>
          <DialogTitle>
            {t(`messaging.platforms.${p?.nameKey ?? platform}`)}
          </DialogTitle>
          <DialogDescription>
            {t("phase5.messagingDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-3">
          {p && <StatePill>{t(`messaging.states.${p.state}`)}</StatePill>}
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
                    disabled={deciding.includes(u.userId)}
                    onClick={() =>
                      decide.mutate({
                        platformId: platform,
                        userId: u.userId,
                        decision,
                      })
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
                  disabled={deciding.includes(u.userId)}
                  onClick={() =>
                    decide.mutate({
                      platformId: platform,
                      userId: u.userId,
                      decision: u.status === "paused" ? "resume" : "pause",
                    })
                  }
                >
                  {t(u.status === "paused" ? "phase5.resume" : "phase5.pause")}
                </Button>
                <ConfirmAction
                  title={t("phase5.revokeTitle")}
                  description={t("phase5.revokeDescription")}
                  label={t("phase5.revoke")}
                  onConfirm={() =>
                    decide.mutateAsync({
                      platformId: platform,
                      userId: u.userId,
                      decision: "revoke",
                    })
                  }
                />
              </SettingRow>
            ))}
          <ConfirmAction
            title={t("phase5.unlinkTitle")}
            description={t("phase5.unlinkDescription")}
            label={t("phase5.unlink")}
            onConfirm={async () => {
              if (sharedId)
                await unlinkShared.mutateAsync({ platformId: sharedId });
              await disablePlatform(
                { transport, queryClient: cache },
                platform
              );
            }}
          />
          <Button variant="secondary" onClick={() => void close()}>
            {t("phase5.done")}
          </Button>
        </div>
      </ConnectDialogContent>
    </Dialog>
  );
};

const PlatformCredentials = ({
  platform,
}: {
  platform: MessagingPlatformInfo;
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const writesSnapshot = useWritesSnapshot();
  const save = useMutation(
    transport.orpc.messaging.updatePlatform.mutationOptions({
      ...writesSnapshot,
      meta: { errorToast: "phase5.saveFailed" },
    })
  );
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
      const values = Object.fromEntries(
        Object.entries(v.parse(schema, value)).filter(
          ([, value]) => value !== ""
        )
      );
      // A failure is toasted by the mutation's meta; the fields keep it.
      await save.mutateAsync({ platformId: platform.id, values }).then(
        () => form.reset(),
        () => undefined
      );
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
