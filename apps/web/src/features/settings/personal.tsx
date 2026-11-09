import { AgentMode } from "@abacus-ai/contract/agent-types";
import { languageNameTag } from "@abacus-ai/contract/contract/languages";
import {
  SUPPORTED_LANGUAGES,
  type MemoryRow,
  type PrefsRow,
  type SupportedLanguage,
} from "@abacus-ai/contract/contract/rows";
import type {
  MemoryChangeView,
  MemoryProjectView,
} from "@abacus-ai/contract/contracts";
import { isQuietNow } from "@abacus-ai/contract/quiet-hours";
import { EMPTY_RATING_PROMPT_CARD } from "@abacus-ai/contract/rating-prompt";
import { useLiveQuery } from "@tanstack/react-db";
import { revalidateLogic } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { CompanionSettings } from "#platform/companion";
import { BotAvatar } from "#renderer/components/bot-avatar";
import { useAppForm } from "#renderer/components/form-kit";
import { ConfirmAction } from "#renderer/components/form-kit/confirm";
import { Choice, SettingSwitch } from "#renderer/components/form-kit/controls";
import {
  AreaPage,
  GroupCard,
  PageNote,
  SettingRow,
  StatePill,
} from "#renderer/components/form-kit/page";
import { SoundPreview } from "#renderer/components/sound-preview";
import { useCollections } from "#renderer/data/db";
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import {
  optimistic,
  useMutation,
  isRpcError,
} from "#renderer/data/query-client";
import { resolveLook } from "#renderer/lib/bots/avatar";
import { cn } from "#renderer/lib/cn";
import { formatDayAgo, formatWhen } from "#renderer/lib/format-time";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { IS_ELECTRON } from "#renderer/lib/platform";
import type { Cue } from "#renderer/lib/sound";
import { showError } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";
import { useNow } from "#renderer/lib/use-now";
import { Button } from "#renderer/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#renderer/ui/collapsible";
import { Input } from "#renderer/ui/input";
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
  const setLoginItem = useMutation(
    transport.orpc.system.loginItem.set.mutationOptions({
      ...optimistic(
        transport.orpc.system.loginItem.get.queryKey({ input: {} }),
        (_old, value: { openAtLogin: boolean }) => value
      ),
      meta: { errorToast: "phase5.saveFailed" },
    })
  );
  const setBotMode = useMutation(
    transport.orpc.settings.defaultMode.set.mutationOptions({
      onSuccess: (value) =>
        cache.setQueryData(
          transport.orpc.settings.defaultMode.get.queryKey({ input: {} }),
          value
        ),
      meta: { errorToast: "phase5.saveFailed" },
    })
  );
  return (
    <AreaPage title={t("settings.pages.general")}>
      <CompanionSettings />
      <GroupCard>
        <LanguageRow />
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
              onCheckedChange={(openAtLogin) =>
                setLoginItem.mutate({ openAtLogin })
              }
            />
          </SettingRow>
        )}
        <SettingRow
          id="showLinkPreviews"
          title={t("phase5.settings.showLinkPreviews")}
          detail={t("phase5.settings.linkPreviewsDetail")}
        >
          <SettingSwitch
            id="showLinkPreviews"
            checked={prefs.showLinkPreviews !== false}
            onCheckedChange={(showLinkPreviews) =>
              void update({ showLinkPreviews }).catch(fail)
            }
          />
        </SettingRow>
      </GroupCard>
      <GroupCard>
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
        <SettingRow
          id="defaultMode"
          title={t("phase5.settings.defaultMode")}
          detail={t(`phase5.modeDescriptions.${prefs.defaultMode}`)}
        >
          {prefs.defaultMode === "YOLO" && (
            <StatePill tone="warning">{t("phase5.careful")}</StatePill>
          )}
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
          <SettingRow
            id="botMode"
            title={t("phase5.settings.botMode")}
            detail={t(`phase5.modeDescriptions.${botMode.data ?? "YOLO"}`)}
          >
            <Choice
              id="botMode"
              value={botMode.data ?? "YOLO"}
              options={[
                { value: "YOLO", label: t("phase5.fullAccess") },
                { value: "AUTO", label: t("phase5.auto") },
              ]}
              onChange={(mode) =>
                setBotMode.mutate({
                  mode: mode as AgentMode.Auto | AgentMode.Yolo,
                })
              }
            />
          </SettingRow>
        )}
      </GroupCard>
    </AreaPage>
  );
};
const LanguageRow = () => {
  const { t, i18n } = useTranslation();
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  return (
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
              }).of(languageNameTag(i18n.language as SupportedLanguage)),
            }),
          },
          ...SUPPORTED_LANGUAGES.map((x) => ({
            value: x,
            label:
              new Intl.DisplayNames([x], { type: "language" }).of(
                languageNameTag(x)
              ) ?? x,
          })),
        ]}
        onChange={(language) =>
          void update({ language: language as PrefsRow["language"] }).catch(
            () => showError(t("phase5.saveFailed"))
          )
        }
      />
    </SettingRow>
  );
};
const InstructionSchema = v.object({ text: v.pipe(v.string(), v.trim()) });
type NoteType = MemoryRow["type"];
type MemoryScope = { scope: "you" } | { scope: "project"; project: string };
const TYPE_LABELS = {
  profile: "memory.types.profile",
  rule: "memory.types.rule",
  preference: "memory.types.preference",
  fact: "memory.types.fact",
  decision: "memory.types.decision",
  reference: "memory.types.reference",
  status: "memory.types.status",
  card: "memory.types.card",
} as const;
/** What the Add row offers; a status note needs an expiry the agent sets. */
const ADDABLE: NoteType[] = [
  "rule",
  "preference",
  "fact",
  "decision",
  "reference",
  "profile",
];
const KIND_LABELS = {
  folder: "memory.kinds.folder",
  bot: "memory.kinds.bot",
  routine: "memory.kinds.routine",
  topic: "memory.kinds.topic",
} as const;
const ACTION_LABELS = {
  saved: "memory.history.saved",
  changed: "memory.history.changed",
  forgot: "memory.history.forgot",
  noted: "memory.history.noted",
} as const;
const AUTHOR_LABELS = {
  you: "memory.by.you",
  chat: "memory.by.chat",
  routine: "memory.by.routine",
  bot: "memory.by.bot",
  contact: "memory.by.contact",
  app: "memory.by.app",
} as const;
/** Rules and preferences first: they are what every chat obeys. */
const TYPE_ORDER: NoteType[] = [
  "rule",
  "preference",
  "profile",
  "decision",
  "fact",
  "reference",
  "status",
];
const byTypeThenName = (a: MemoryRow, b: MemoryRow) =>
  TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) ||
  a.name.localeCompare(b.name);
/** The page's writes: a refusal names its reason, anything else says so plainly. */
const useMemoryWrites = () => {
  const { t } = useTranslation();
  const { transport, db } = useAppContext();
  const fail = (error: unknown) =>
    showError(
      isRpcError(error) && error.code === "BAD_REQUEST"
        ? t("memory.saveRefused", { reason: error.message })
        : isRpcError(error) && error.code === "CONFLICT"
          ? t("memory.busy")
          : t("phase5.saveFailed")
    );
  return {
    /** Resolves true once saved; a failure is shown. */
    save: (
      scope: MemoryScope,
      note: { name?: string; type: NoteType; text: string }
    ): Promise<boolean> =>
      transport.client.memory
        .save({ ...scope, ...note })
        .then(() => true)
        .catch((error: unknown) => {
          fail(error);
          return false;
        }),
    forget: (row: MemoryRow) =>
      db.collections.memories.delete(row.id).isPersisted.promise.catch(fail),
  };
};
const NoteRow = ({
  row,
  scope,
  label,
}: {
  row: MemoryRow;
  scope: MemoryScope;
  label?: string;
}) => {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const writes = useMemoryWrites();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <SettingRow
        id={`memory-${row.id}`}
        title={row.body}
        detail={[
          label,
          t(TYPE_LABELS[row.type]),
          formatDayAgo(row.updated, now, i18n.language),
        ]
          .filter(Boolean)
          .join(" · ")}
      >
        {draft == null && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDraft(row.body)}
            >
              {t("memory.edit")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void writes.forget(row).finally(() => setBusy(false));
              }}
            >
              {t("phase5.forget")}
            </Button>
          </>
        )}
      </SettingRow>
      {draft != null && (
        <form
          className="space-y-2 px-3 pb-3"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            void writes
              .save(scope, { name: row.name, type: row.type, text: draft })
              .then((saved) => {
                if (saved) setDraft(null);
              })
              .finally(() => setBusy(false));
          }}
        >
          <Textarea
            aria-label={t("memory.edit")}
            rows={row.type === "card" ? 6 : 3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              type="submit"
              disabled={busy || draft.trim() === "" || draft === row.body}
            >
              {t("phase5.save")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => setDraft(null)}
            >
              {t("phase5.cancel")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
};
const AddNoteRow = ({ id, scope }: { id: string; scope: MemoryScope }) => {
  const { t } = useTranslation();
  const writes = useMemoryWrites();
  const [type, setType] = useState<NoteType>("rule");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-wrap items-start gap-2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void writes
          .save(scope, { type, text })
          .then((saved) => {
            if (saved) setText("");
          })
          .finally(() => setBusy(false));
      }}
    >
      <span id={`${id}-label`} className="sr-only">
        {t("memory.typeLabel")}
      </span>
      <Choice
        id={id}
        value={type}
        options={ADDABLE.map((value) => ({
          value,
          label: t(TYPE_LABELS[value]),
        }))}
        onChange={(value) => setType(value as NoteType)}
      />
      <Input
        className="min-w-0 flex-[1_1_200px]"
        aria-label={t("memory.addPlaceholder")}
        placeholder={t("memory.addPlaceholder")}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <Button size="sm" type="submit" disabled={busy || text.trim() === ""}>
        {t("memory.add")}
      </Button>
    </form>
  );
};
const ProjectCard = ({
  project,
  rows,
}: {
  project: MemoryProjectView;
  rows: MemoryRow[];
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const bots = useLiveQuery(useCollections().bots).data ?? [];
  const bot =
    project.kind === "bot"
      ? bots.find((each) => each.id === project.key)
      : undefined;
  const scope: MemoryScope = { scope: "project", project: project.slug };
  const card = rows.find((row) => row.type === "card");
  const notes = rows
    .filter((row) => row.scope === "project" && row.type !== "card")
    .sort(byTypeThenName);
  const contacts = rows.filter((row) => row.scope === "contact");
  return (
    <Collapsible>
      <SettingRow
        id={`memory-project-${project.slug}`}
        title={bot?.name ?? project.name}
        detail={[t(KIND_LABELS[project.kind]), project.path]
          .filter(Boolean)
          .join(" · ")}
        media={
          bot != null ? (
            <BotAvatar animate look={resolveLook(bot)} size={28} />
          ) : undefined
        }
      >
        {bot != null && (
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
        )}
        <CollapsibleTrigger render={<Button size="sm" variant="ghost" />}>
          {t("phase5.showMemory")}
        </CollapsibleTrigger>
      </SettingRow>
      <CollapsibleContent className="pb-2">
        {card != null && (
          <NoteRow row={card} scope={scope} label={t("memory.types.card")} />
        )}
        {notes.map((row) => (
          <NoteRow key={row.id} row={row} scope={scope} />
        ))}
        {contacts.map((row) => (
          <NoteRow
            key={row.id}
            row={row}
            scope={scope}
            label={t("memory.aboutContact", { name: row.contact })}
          />
        ))}
        <AddNoteRow id={`memory-add-${project.slug}`} scope={scope} />
        <ConfirmAction
          title={t("memory.clearProject")}
          description={t("memory.clearProjectDetail")}
          label={t("phase5.clearAll")}
          onConfirm={() => transport.client.memory.clear(scope)}
        />
      </CollapsibleContent>
    </Collapsible>
  );
};
const HistoryCard = ({
  changes,
  projects,
}: {
  changes: MemoryChangeView[];
  projects: MemoryProjectView[];
}) => {
  const { t, i18n } = useTranslation();
  const { transport } = useAppContext();
  const now = useNow();
  const [pending, setPending] = useState<string | null>(null);
  const where = (change: MemoryChangeView) =>
    change.project == null
      ? t("memory.you.title")
      : (projects.find((project) => project.slug === change.project)?.name ??
        change.project);
  return (
    <GroupCard title={t("memory.history.title")}>
      {changes.map((change) => (
        <SettingRow
          key={change.id}
          id={`memory-change-${change.id}`}
          title={`${t(ACTION_LABELS[change.action])} · ${change.summary || change.name || ""}`}
          detail={[
            t(AUTHOR_LABELS[change.by]),
            where(change),
            formatWhen(change.at, now, i18n.language),
          ].join(" · ")}
        >
          {change.undoable && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending === change.id}
              onClick={() => {
                setPending(change.id);
                void transport.client.memory
                  .undo({ id: change.id })
                  .catch((error: unknown) =>
                    showError(
                      t(
                        isRpcError(error) && error.code === "CONFLICT"
                          ? "memory.history.changedSince"
                          : "phase5.saveFailed"
                      )
                    )
                  )
                  .finally(() => setPending(null));
              }}
            >
              {t("memory.history.undo")}
            </Button>
          )}
        </SettingRow>
      ))}
    </GroupCard>
  );
};
export const MemoryPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const c = useCollections();
  const memoryQuery = useLiveQuery(c.memories);
  const memories = memoryQuery.data ?? [];
  const projects = useQuery(
    transport.orpc.memory.projects.queryOptions({ input: {} })
  );
  const history = useQuery(
    transport.orpc.memory.history.queryOptions({ input: {} })
  );
  const withheld = useQuery(
    transport.orpc.memory.withheld.queryOptions({ input: {} })
  );
  const query = useQuery({
    ...transport.orpc.memory.customInstructions.get.queryOptions({ input: {} }),
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const saveInstructions = useMutation(
    transport.orpc.memory.customInstructions.set.mutationOptions({
      onSuccess: (saved) =>
        cache.setQueryData(
          transport.orpc.memory.customInstructions.get.queryKey({ input: {} }),
          saved
        ),
      meta: { errorToast: "phase5.saveFailed" },
    })
  );
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
      // A failure is toasted by the mutation's meta; the field keeps the text.
      const saved = await saveInstructions
        .mutateAsync(v.parse(InstructionSchema, value))
        .catch(() => null);
      if (saved === null) return;
      baseline.current = saved;
      setRemoteChanged(false);
      form.reset({ text: saved });
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
  const you = memories
    .filter((row) => row.scope === "you")
    .sort(byTypeThenName);
  const changes = history.data ?? [];
  const failed =
    memoryQuery.isError || projects.isError || history.isError || query.isError;
  return (
    <AreaPage
      title={t("settings.pages.memory")}
      description={t("phase5.settings.memoryDetail")}
    >
      {memoryQuery.isLoading && <PageNote live>{t("memory.loading")}</PageNote>}
      {failed && (
        <div className="flex items-center gap-3">
          <PageNote error>{t("memory.readFailed")}</PageNote>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void projects.refetch();
              void history.refetch();
              void query.refetch();
            }}
          >
            {t("phase5.retry")}
          </Button>
        </div>
      )}
      {!memoryQuery.isLoading &&
        !failed &&
        memories.length === 0 &&
        changes.length === 0 && <PageNote>{t("memory.empty")}</PageNote>}
      <GroupCard>
        <SettingRow
          id="customInstructions"
          title={t("phase5.settings.customInstructions")}
        />
        {remoteChanged && (
          <PageNote live className="px-3">
            {t("phase5.remoteChanged")}
          </PageNote>
        )}
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
      <GroupCard title={t("memory.you.title")}>
        <SettingRow
          id="memory-you"
          title={t("memory.you.title")}
          detail={t("memory.you.detail")}
        />
        {you.map((row) => (
          <NoteRow key={row.id} row={row} scope={{ scope: "you" }} />
        ))}
        <AddNoteRow id="memory-add-you" scope={{ scope: "you" }} />
        {you.length > 0 && (
          <ConfirmAction
            title={t("memory.clearYou")}
            description={t("phase5.forgetDescription")}
            label={t("phase5.clearAll")}
            onConfirm={() => transport.client.memory.clear({ scope: "you" })}
          />
        )}
      </GroupCard>
      {(projects.data ?? []).length > 0 && (
        <GroupCard title={t("memory.projects.title")}>
          {(projects.data ?? []).map((project) => (
            <ProjectCard
              key={project.slug}
              project={project}
              rows={memories.filter((row) => row.project === project.slug)}
            />
          ))}
        </GroupCard>
      )}
      {changes.length > 0 && (
        <HistoryCard changes={changes} projects={projects.data ?? []} />
      )}
      {(withheld.data ?? []).length > 0 && (
        <PageNote>
          {t("memory.withheld", {
            entries: (withheld.data ?? [])
              .map((entry) => `${entry.from}: ${entry.preview}`)
              .join(", "),
          })}
        </PageNote>
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
            // System notifications are always silent; their `sound` flag
            // only mirrors Play sounds, which is the one sound control.
            onCheckedChange={(enabled) =>
              setNotify.mutate({ enabled, sound: prefs.sounds.enabled })
            }
          />
        </SettingRow>
        <SettingRow
          id="projectReminders"
          title={t("phase5.settings.projectReminders")}
          detail={t("phase5.settings.projectRemindersDetail")}
        >
          <SettingSwitch
            id="projectReminders"
            // Notify me off silences these too.
            disabled={!(notification.data?.enabled ?? true)}
            checked={prefs.projectReminders !== false}
            onCheckedChange={(projectReminders) =>
              void update({ projectReminders }).catch(fail)
            }
          />
        </SettingRow>
      </GroupCard>
      <GroupCard>
        <SettingRow
          id="ratingPrompt"
          title={t("phase5.settings.ratingPrompt")}
          detail={t("phase5.settings.ratingPromptDetail")}
        >
          <SettingSwitch
            id="ratingPrompt"
            checked={!(prefs.dismissals.ratingPrompt?.off ?? false)}
            onCheckedChange={(enabled) =>
              void update({
                dismissals: {
                  ratingPrompt: {
                    ...(prefs.dismissals.ratingPrompt ??
                      EMPTY_RATING_PROMPT_CARD),
                    off: !enabled,
                  },
                },
              }).catch(fail)
            }
          />
        </SettingRow>
      </GroupCard>
      <GroupCard>
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
              disabled={!prefs.sounds.enabled}
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
      </GroupCard>
      <GroupCard>
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
            <label
              className={cn(
                "flex flex-col gap-1 text-xs",
                !quiet.enabled && "text-muted-foreground"
              )}
            >
              {t(`phase5.${key}`)}
              <Input
                className="w-32"
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
      {error && (
        <p role="alert" className="text-destructive self-end text-xs">
          {t("phase5.differentTimes")}
        </p>
      )}
    </div>
  );
};
