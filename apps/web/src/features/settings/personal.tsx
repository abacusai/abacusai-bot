import { AgentMode } from "@abacus-ai/contract/agent-types";
import {
  SUPPORTED_LANGUAGES,
  type PrefsRow,
} from "@abacus-ai/contract/contract/rows";
import { useLiveQuery } from "@tanstack/react-db";
import { revalidateLogic } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { CompanionSettings } from "#platform/companion";
import { BotAvatar } from "#renderer/components/bot-avatar";
import { BotMemoryList } from "#renderer/components/bot-memory-list";
import { useAppForm } from "#renderer/components/form-kit";
import { ConfirmAction } from "#renderer/components/form-kit/confirm";
import { Choice, SettingSwitch } from "#renderer/components/form-kit/controls";
import {
  AreaPage,
  GroupCard,
  SettingRow,
  StatePill,
} from "#renderer/components/form-kit/page";
import { SoundPreview } from "#renderer/components/sound-preview";
import { useCollections } from "#renderer/data/db";
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { optimistic, useMutation } from "#renderer/data/query-client";
import { resolveLook } from "#renderer/lib/bots/avatar";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { isQuietNow } from "#renderer/lib/notify";
import { IS_ELECTRON } from "#renderer/lib/platform";
import type { Cue } from "#renderer/lib/sound";
import { showError } from "#renderer/lib/toast";
import { useAppContext, rpcError } from "#renderer/lib/use-app-context";
import { useNow } from "#renderer/lib/use-now";
import { Button } from "#renderer/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#renderer/ui/collapsible";
import { Textarea } from "#renderer/ui/textarea";
const modes = [
  "AUTO",
  "DEFAULT",
  "ACCEPTEDITS",
  "PLAN",
  "YOLO",
] as PrefsRow["defaultMode"][];
export const GeneralPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  const c = useCollections();
  const workspaces = useLiveQuery(c.workspaces).data ?? [];
  const info = useQuery(transport.orpc.system.info.queryOptions({ input: {} }));
  const login = useQuery({
    ...transport.orpc.system.loginItem.get.queryOptions({ input: {} }),
    enabled: IS_ELECTRON && info.data != null && info.data.platform !== "linux",
  });
  const sandbox = useQuery(
    transport.orpc.settings.sandboxSupport.queryOptions({ input: {} })
  );
  const botMode = useQuery(
    transport.orpc.settings.defaultMode.get.queryOptions({ input: {} })
  );
  const fail = () => showError(t("phase5.saveFailed"));
  return (
    <AreaPage title={t("settings.pages.general")}>
      <CompanionSettings />
      <GroupCard>
        {IS_ELECTRON && info.data?.platform !== "linux" && (
          <SettingRow
            id="launchAtLogin"
            title={t("phase5.settings.launchAtLogin")}
            detail={t("phase5.settings.launchDetail")}
          >
            <SettingSwitch
              id="launchAtLogin"
              checked={login.data?.openAtLogin ?? false}
              disabled={!login.data}
              onCheckedChange={(value) => {
                const key = transport.orpc.system.loginItem.get.queryKey({
                  input: {},
                });
                const previous = login.data;
                cache.setQueryData(key, { openAtLogin: value });
                void transport.client.system.loginItem
                  .set({ openAtLogin: value })
                  .then((result) => cache.setQueryData(key, result))
                  .catch(() => {
                    cache.setQueryData(key, previous);
                    fail();
                  });
              }}
            />
          </SettingRow>
        )}
        <SettingRow
          id="defaultWorkspace"
          title={t("phase5.settings.defaultWorkspace")}
          detail={t("phase5.settings.workspaceDetail")}
        >
          <Choice
            id="defaultWorkspace"
            value={prefs.lastPickedWorkspaceId ?? ""}
            options={[
              { value: "", label: t("phase5.defaultWorkspace") },
              ...workspaces
                .filter((w) => w.kind == null || w.kind === "auto")
                .map((w) => ({ value: w.id, label: w.label })),
            ]}
            onChange={(id) =>
              void update({ lastPickedWorkspaceId: id || null }).catch(fail)
            }
          />
        </SettingRow>
        <SettingRow id="defaultMode" title={t("phase5.settings.defaultMode")}>
          <Choice
            id="defaultMode"
            value={prefs.defaultMode}
            options={modes
              .filter((m) => m !== "AUTO" || sandbox.data?.available)
              .map((m) => ({ value: m, label: t(`chat.mode.${m}`) }))}
            onChange={(mode) =>
              void update({
                defaultMode: mode as PrefsRow["defaultMode"],
              }).catch(fail)
            }
          />
        </SettingRow>
        {sandbox.data?.available && (
          <SettingRow id="botMode" title={t("phase5.settings.botMode")}>
            <Choice
              id="botMode"
              value={botMode.data ?? "YOLO"}
              options={[
                { value: "YOLO", label: t("phase5.fullAccess") },
                { value: "AUTO", label: t("phase5.auto") },
              ]}
              onChange={(mode) =>
                void transport.client.settings.defaultMode
                  .set({ mode: mode as AgentMode.Auto | AgentMode.Yolo })
                  .then((value) =>
                    cache.setQueryData(
                      transport.orpc.settings.defaultMode.get.queryKey({
                        input: {},
                      }),
                      value
                    )
                  )
                  .catch(fail)
              }
            />
          </SettingRow>
        )}
      </GroupCard>
      <GroupCard title={t("phase5.settings.modes")}>
        {modes.map((m) => (
          <SettingRow
            key={m}
            id={`mode-${m}`}
            title={t(`chat.mode.${m}`)}
            detail={t(`phase5.modeDescriptions.${m}`)}
          >
            {m === "YOLO" && <StatePill>{t("phase5.careful")}</StatePill>}
          </SettingRow>
        ))}
      </GroupCard>
    </AreaPage>
  );
};
export const LanguagePage = () => {
  const { t, i18n } = useTranslation();
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  return (
    <AreaPage title={t("settings.pages.language")}>
      <GroupCard>
        <SettingRow
          id="language"
          title={t("phase5.settings.language")}
          detail={t("phase5.settings.languageDetail")}
        >
          <Choice
            id="language"
            value={prefs.language}
            options={[
              {
                value: "system",
                label: t("phase5.systemLanguage", {
                  language: new Intl.DisplayNames([i18n.language], {
                    type: "language",
                  }).of(i18n.language),
                }),
              },
              ...SUPPORTED_LANGUAGES.map((x) => ({
                value: x,
                label:
                  new Intl.DisplayNames([x], { type: "language" }).of(x) ?? x,
              })),
            ]}
            onChange={(language) =>
              void update({ language: language as PrefsRow["language"] }).catch(
                () => showError(t("phase5.saveFailed"))
              )
            }
          />
        </SettingRow>
      </GroupCard>
    </AreaPage>
  );
};
const InstructionSchema = v.object({ text: v.pipe(v.string(), v.trim()) });
export const MemoryPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const c = useCollections();
  const memoryQuery = useLiveQuery(c.memories);
  const memories = memoryQuery.data ?? [];
  const bots = useLiveQuery(c.bots).data ?? [];
  const botNotes = useQuery(
    transport.orpc.memory.bots.queryOptions({ input: {} })
  );
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [pendingMemory, setPendingMemory] = useState<string | undefined>();
  const forget = async (id: string) => {
    setPendingMemory(id);
    try {
      await c.memories.delete(id).isPersisted.promise;
      setMemoryError(null);
    } catch (error) {
      setMemoryError(
        t(
          rpcError(error)?.code === "CONFLICT"
            ? "phase5.memoryConflict"
            : "phase5.saveFailed"
        )
      );
    }
    setPendingMemory(undefined);
  };
  const query = useQuery({
    ...transport.orpc.memory.customInstructions.get.queryOptions({ input: {} }),
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const baseline = useRef(query.data ?? "");
  const [remoteChanged, setRemoteChanged] = useState(false);
  const form = useAppForm({
    defaultValues: { text: query.data ?? "" },
    validationLogic: revalidateLogic({
      mode: "blur",
      modeAfterSubmission: "change",
    }),
    validators: { onDynamic: InstructionSchema },
    onSubmit: async ({ value }) => {
      try {
        const saved = await transport.client.memory.customInstructions.set(
          v.parse(InstructionSchema, value)
        );
        cache.setQueryData(
          transport.orpc.memory.customInstructions.get.queryKey({ input: {} }),
          saved
        );
        baseline.current = saved;
        setRemoteChanged(false);
        form.reset({ text: saved });
      } catch {
        showError(t("phase5.saveFailed"));
      }
    },
  });
  useEffect(() => {
    if (query.data === undefined || query.data === baseline.current) return;
    if (form.state.values.text === baseline.current) {
      form.setFieldValue("text", query.data, {
        dontUpdateMeta: true,
        dontValidate: true,
        dontRunListeners: true,
      });
    } else {
      // The remote query has advanced beyond this field's editing baseline.
      setRemoteChanged(true);
    }
    baseline.current = query.data;
  }, [query.data, form]);
  return (
    <AreaPage
      title={t("settings.pages.memory")}
      description={t("phase5.settings.memoryDetail")}
    >
      {memoryQuery.isLoading && <p role="status">{t("memory.loading")}</p>}
      {(memoryQuery.isError || botNotes.isError || query.isError) && (
        <div role="alert">
          <p>{t("memory.readFailed")}</p>
          <Button
            onClick={() => {
              void botNotes.refetch();
              void query.refetch();
            }}
          >
            {t("phase5.retry")}
          </Button>
        </div>
      )}
      {!memoryQuery.isLoading &&
        !memoryQuery.isError &&
        memories.length === 0 &&
        !botNotes.data?.some((bot) => bot.noteDays > 0) && (
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t("memory.empty")}
          </p>
        )}
      <GroupCard>
        <SettingRow
          id="customInstructions"
          title={t("phase5.settings.customInstructions")}
        />
        {remoteChanged && <p role="status">{t("phase5.remoteChanged")}</p>}
        <form
          className="space-y-3 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field name="text">
            {(f) => (
              <Textarea
                aria-label={t("phase5.settings.customInstructions")}
                rows={5}
                disabled={query.isPending || query.isError}
                value={f.state.value}
                onChange={(e) => f.handleChange(e.target.value)}
                onBlur={f.handleBlur}
              />
            )}
          </form.Field>
          <form.Subscribe
            selector={(s) => [s.values.text, s.isSubmitting] as const}
          >
            {([text, busy]) => (
              <Button
                disabled={
                  query.isPending ||
                  query.isError ||
                  busy ||
                  text.trim() === (query.data ?? "").trim()
                }
                type="submit"
              >
                {t("phase5.save")}
              </Button>
            )}
          </form.Subscribe>
        </form>
      </GroupCard>
      {memoryError && <p role="alert">{memoryError}</p>}
      {(["remember", "user", "memory"] as const)
        .filter((target) =>
          memories.some((m) => m.scope === "global" && m.target === target)
        )
        .map((target) => (
          <GroupCard key={target} title={t(`phase5.memoryTargets.${target}`)}>
            {memories
              .filter((m) => m.scope === "global" && m.target === target)
              .map((m) => (
                <SettingRow key={m.id} id={`memory-${m.id}`} title={m.entry}>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      void forget(m.id);
                    }}
                  >
                    {t("phase5.forget")}
                  </Button>
                </SettingRow>
              ))}
            <ConfirmAction
              title={t("phase5.clearAll")}
              description={t("phase5.forgetDescription")}
              label={t("phase5.clearAll")}
              onConfirm={() => transport.client.memory.forgetAll({ target })}
            />
          </GroupCard>
        ))}
      {(memories.some((m) => m.scope === "bot") ||
        botNotes.data?.some((bot) => bot.noteDays > 0)) && (
        <GroupCard title={t("phase5.rememberedByBots")}>
          {bots.map((bot) => {
            const entries = memories.filter(
              (row) => row.scope === "bot" && row.botId === bot.id
            );
            const noteDays =
              botNotes.data?.find((item) => item.botId === bot.id)?.noteDays ??
              0;
            if (!entries.length && !noteDays) return null;
            return (
              <Collapsible key={bot.id}>
                <SettingRow
                  id={`memory-bot-${bot.id}`}
                  title={t("phase5.botMemoryCount", {
                    name: bot.name,
                    count: entries.length,
                  })}
                  detail={entries
                    .slice(0, 3)
                    .map((row) => row.entry)
                    .join(" · ")}
                >
                  <BotAvatar look={resolveLook(bot)} size={28} />
                  <Button
                    size="sm"
                    variant="secondary"
                    nativeButton={false}
                    render={
                      <AppLink
                        to="/bots/$botId"
                        params={{ botId: bot.id }}
                        search={{ tab: "memory" }}
                        transition="settings-out"
                      />
                    }
                  >
                    {t("phase5.openAction")}
                  </Button>
                  <CollapsibleTrigger
                    render={<Button size="sm" variant="ghost" />}
                  >
                    {t("phase5.showMemory")}
                  </CollapsibleTrigger>
                </SettingRow>
                <CollapsibleContent className="px-3 pb-3">
                  <BotMemoryList
                    entries={entries}
                    pendingId={pendingMemory}
                    onForget={(row) => void forget(row.id)}
                  />
                  {noteDays > 0 && (
                    <p className="text-muted-foreground text-xs">
                      {t("bots.panel.memory.notes", { count: noteDays })}
                    </p>
                  )}
                  <ConfirmAction
                    title={t("bots.panel.memory.clear")}
                    description={t("phase5.forgetDescription")}
                    label={t("phase5.clearAll")}
                    onConfirm={async () => {
                      const next = await transport.client.memory.clearBot({
                        botId: bot.id,
                      });
                      cache.setQueryData(
                        transport.orpc.memory.bots.queryKey({ input: {} }),
                        next
                      );
                    }}
                  />
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </GroupCard>
      )}
    </AreaPage>
  );
};
export const NotificationsPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  const bots = useLiveQuery(useCollections().bots).data ?? [];
  const notification = useQuery(
    transport.orpc.settings.notifications.get.queryOptions({ input: {} })
  );
  const fail = () => showError(t("phase5.saveFailed"));
  const setNotify = useMutation(
    transport.orpc.settings.notifications.set.mutationOptions({
      ...optimistic(
        transport.orpc.settings.notifications.get.queryKey({ input: {} }),
        (_data, value: { enabled: boolean; sound: boolean }) => value
      ),
      meta: { errorToast: "phase5.saveFailed" },
    })
  );
  const q = prefs.sounds.quietHours ?? {
    enabled: false,
    start: "22:00",
    end: "08:00",
  };
  const now = useNow();
  return (
    <AreaPage
      title={t("settings.pages.notifications")}
      description={t("phase5.settings.notificationDetail")}
    >
      <GroupCard>
        <CompanionSettings notifications />
        <SettingRow
          id="notify"
          title={t("phase5.settings.notify")}
          detail={t("phase5.settings.notifyDetail")}
        >
          <SettingSwitch
            id="notify"
            checked={notification.data?.enabled ?? true}
            onCheckedChange={(enabled) =>
              setNotify.mutate({
                enabled,
                sound: notification.data?.sound ?? true,
              })
            }
          />
        </SettingRow>
        <SettingRow id="sounds" title={t("phase5.settings.sounds")}>
          <SettingSwitch
            id="sounds"
            checked={prefs.sounds.enabled}
            onCheckedChange={(enabled) =>
              void update({ sounds: { enabled } }).catch(fail)
            }
          />
        </SettingRow>
        {(
          [
            "sent",
            "received",
            "needs-you",
            "done",
            "failed",
            "routine-fired",
          ] as Cue[]
        ).map((cue) => (
          <SettingRow
            key={cue}
            id={`sound-${cue}`}
            title={t(`phase5.cues.${cue}`)}
          >
            <SoundPreview cue={cue} />
            <SettingSwitch
              id={`sound-${cue}`}
              checked={prefs.sounds.perEvent[cue] !== false}
              onCheckedChange={(enabled) =>
                void update({
                  sounds: {
                    perEvent: { ...prefs.sounds.perEvent, [cue]: enabled },
                  },
                }).catch(fail)
              }
            />
          </SettingRow>
        ))}
        <SettingRow
          id="quietHours"
          title={t("phase5.settings.quietHours")}
          detail={
            isQuietNow(q, new Date(now))
              ? t("phase5.quietUntil", { end: q.end })
              : undefined
          }
        >
          <SettingSwitch
            id="quietHours"
            checked={q.enabled}
            onCheckedChange={(enabled) =>
              void update({ sounds: { quietHours: { ...q, enabled } } }).catch(
                fail
              )
            }
          />
        </SettingRow>
        <QuietTimes quiet={q} />
      </GroupCard>
      {bots.length > 0 && (
        <GroupCard title={t("phase5.settings.perBot")}>
          {bots.map((bot) => (
            <SettingRow
              id={`sounds-bot-${bot.id}`}
              key={bot.id}
              title={bot.name}
            >
              <Choice
                id={`sounds-bot-${bot.id}`}
                value={prefs.sounds.perBot?.[bot.id] ?? "all"}
                options={["all", "needs-me", "nothing"].map((x) => ({
                  value: x,
                  label: t(`phase5.botSounds.${x}`),
                }))}
                onChange={(level) =>
                  void update({
                    sounds: {
                      perBot: {
                        ...prefs.sounds.perBot,
                        [bot.id]: level as "all" | "needs-me" | "nothing",
                      },
                    },
                  }).catch(fail)
                }
              />
            </SettingRow>
          ))}
        </GroupCard>
      )}
    </AreaPage>
  );
};
const QuietTimesSchema = v.pipe(
  v.object({
    start: v.pipe(v.string(), v.regex(/^([01]\d|2[0-3]):[0-5]\d$/)),
    end: v.pipe(v.string(), v.regex(/^([01]\d|2[0-3]):[0-5]\d$/)),
  }),
  v.check((x) => x.start !== x.end, "same-time")
);
export const QuietTimes = ({
  quiet,
}: {
  quiet: NonNullable<PrefsRow["sounds"]["quietHours"]>;
}) => {
  const { t } = useTranslation();
  const update = useUpdatePrefs();
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  const form = useAppForm({
    defaultValues: { start: quiet.start, end: quiet.end },
    validators: { onBlur: QuietTimesSchema, onSubmit: QuietTimesSchema },
    onSubmit: async ({ value }) => {
      await update({ sounds: { quietHours: { ...quiet, ...value } } }).catch(
        () => showError(t("phase5.saveFailed"))
      );
    },
  });
  return (
    <div className="flex gap-3 p-3">
      {(["start", "end"] as const).map((key) => (
        <form.Field key={key} name={key}>
          {(f) => (
            <label className="flex flex-col gap-1 text-xs">
              {t(`phase5.${key}`)}
              <input
                className="bg-muted rounded-md p-2"
                type="time"
                disabled={!quiet.enabled}
                value={f.state.value}
                onChange={(e) => f.handleChange(e.target.value)}
                onBlur={() => {
                  f.handleBlur();
                  setError(form.state.values.start === form.state.values.end);
                  if (timer.current) clearTimeout(timer.current);
                  timer.current = setTimeout(
                    () => void form.handleSubmit(),
                    300
                  );
                }}
              />
            </label>
          )}
        </form.Field>
      ))}
      {error && <p role="alert">{t("phase5.differentTimes")}</p>}
    </div>
  );
};
