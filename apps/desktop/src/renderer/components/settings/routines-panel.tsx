import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlarmClock,
  ChevronDown,
  Copy,
  Globe,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type {
  MessagingPairedUser,
  MessagingPairingDecisionRequest,
} from "#shared/messaging";
import type { RoutineListItem, RoutineTrigger } from "#shared/routines";

import {
  useCreateRoutineMutation,
  useRemoveRoutineMutation,
  useRoutinesEventSync,
  useRoutinesQuery,
  useRunRoutineMutation,
  useUpdateRoutineMutation,
} from "../../hooks/use-routines";
import {
  useWorkspaceActiveWorkspaceId,
  useWorkspaceMetadataQuery,
} from "../../hooks/use-workspace-queries";
import { workspaceQueryKeys } from "../../lib/query-keys";
import { Dialog } from "../common/dialog";
import {
  FocusedPage,
  FocusedPageBody,
  FocusedPageLead,
} from "../layout/focused-page";
import {
  Button,
  Field,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Switch,
  Textarea,
  ToggleGroup,
  ToggleGroupItem,
} from "../ui";
import { Badge } from "../ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  composeSchedule,
  DEFAULT_SCHEDULE,
  decomposeCron,
  decomposeSchedule,
  formatTime,
  presetHasTime,
  SCHEDULE_PRESETS,
  toLocalDateTime,
  WEEKDAYS,
  weekdayName,
  type ScheduleDraft,
  type SchedulePreset,
  type Weekday,
} from "./routine-schedule";
import { ROUTINE_TEMPLATES, type RoutineTemplate } from "./routine-templates";

/**
 * Every routine on this machine, in one flat list rather than per-bot pages:
 * "what runs while I'm away" is a question about the machine, and the bot
 * column already says who owns what.
 */

/**
 * Standing auto-replies, beside the schedules: both are the machine acting
 * while the user is away. Rows are the gateway's pairing grants; pause keeps
 * the grant but stops the answers, delete removes the sender entirely.
 */
const AutoRepliesSection = (): JSX.Element | null => {
  const { t } = useTranslation();
  const client = useQueryClient();
  const snapshot = useQuery({
    queryKey: ["routines-messaging-snapshot"],
    queryFn: () => window.api.agent.getMessagingSnapshot(),
    refetchInterval: 15_000,
  });
  const decide = useMutation({
    mutationFn: (request: MessagingPairingDecisionRequest) =>
      window.api.agent.decideMessagingPairing(request),
    onSuccess: () =>
      void client.invalidateQueries({
        queryKey: ["routines-messaging-snapshot"],
      }),
  });

  const rows: MessagingPairedUser[] = snapshot.data?.autoReplies ?? [];
  if (rows.length === 0) return null;

  return (
    <section data-id="auto-replies-section">
      <h3 className="text-sm font-medium">{t("routines.autoRepliesTitle")}</h3>
      <p className="text-muted-foreground mt-0.5 mb-2 text-xs">
        {t("routines.autoRepliesLeadSidebar")}
      </p>
      <div className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <div
            key={`${row.platform}:${row.userId}`}
            className="border-border bg-card/60 flex items-center gap-3 rounded-lg border px-3 py-2"
            data-id={`auto-reply-${row.platform}-${row.userId}`}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">
                {row.userName ?? row.userId}
              </div>
              <div className="text-muted-foreground text-xs">
                {row.platform}
              </div>
            </div>
            <Badge variant={row.status === "approved" ? "default" : "outline"}>
              {row.status === "approved"
                ? t("routines.autoReplyOn")
                : t("routines.autoReplyPaused")}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              data-id="auto-reply-toggle"
              onClick={() =>
                decide.mutate({
                  platformId: row.platform,
                  userId: row.userId,
                  decision: row.status === "approved" ? "pause" : "resume",
                })
              }
            >
              {row.status === "approved"
                ? t("routines.pause")
                : t("routines.resume")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              data-id="auto-reply-delete"
              onClick={() =>
                decide.mutate({
                  platformId: row.platform,
                  userId: row.userId,
                  decision: "revoke",
                })
              }
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
};

export const RoutinesPanel = (): JSX.Element => {
  const { t } = useTranslation();
  useRoutinesEventSync();

  const routinesQuery = useRoutinesQuery();
  const routines = routinesQuery.data ?? [];

  const removeMutation = useRemoveRoutineMutation();
  const runMutation = useRunRoutineMutation();
  const updateMutation = useUpdateRoutineMutation();

  const [dialogState, setDialogState] = useState<{
    open: boolean;
    routine: RoutineListItem | null;
    /** A template's first draft, when the dialog was opened from the shelf. */
    template: RoutineTemplate | null;
  }>({ open: false, routine: null, template: null });
  const [deleteTarget, setDeleteTarget] = useState<RoutineListItem | null>(
    null
  );

  const stats = useMemo(() => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return {
      active: routines.filter((routine) => routine.enabled).length,
      paused: routines.filter((routine) => !routine.enabled).length,
      firedToday: routines.reduce(
        (sum, routine) =>
          sum +
          routine.runs.filter((run) => run.at >= startOfDay.getTime()).length,
        0
      ),
    };
  }, [routines]);

  return (
    <FocusedPage data-id="routines-panel">
      <FocusedPageBody>
        <FocusedPageLead
          description={t("routines.lead")}
          actions={
            <Button
              size="sm"
              data-id="new-routine-btn"
              onClick={() =>
                setDialogState({ open: true, routine: null, template: null })
              }
            >
              <Plus />
              {t("routines.newRoutine")}
            </Button>
          }
        />
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-2" data-id="routine-stats">
            <StatTile
              label={t("routines.statActive")}
              value={stats.active}
              accent
            />
            <StatTile label={t("routines.statPaused")} value={stats.paused} />
            <StatTile
              label={t("routines.statFiredToday")}
              value={stats.firedToday}
            />
          </div>

          {routines.length === 0 ? (
            <div className="border-border text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-sm">
              <AlarmClock className="size-5" />
              {t("routines.empty")}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {routines.map((routine) => (
                <RoutineCard
                  key={routine.id}
                  routine={routine}
                  onToggle={(enabled) =>
                    void updateMutation
                      .mutateAsync({ id: routine.id, changes: { enabled } })
                      .catch(() =>
                        toast.error(t("routines.updateError"), {
                          id: "routine-update",
                        })
                      )
                  }
                  onRun={() =>
                    void runMutation
                      .mutateAsync(routine.id)
                      .then(() =>
                        toast.success(t("routines.ranNow"), {
                          id: "routine-run",
                        })
                      )
                      .catch(() =>
                        toast.error(t("routines.runError"), {
                          id: "routine-run",
                        })
                      )
                  }
                  onEdit={() =>
                    setDialogState({ open: true, routine, template: null })
                  }
                  onDelete={() => setDeleteTarget(routine)}
                />
              ))}
            </div>
          )}

          <AutoRepliesSection />

          <RoutineTemplateShelf
            onPick={(template) =>
              setDialogState({ open: true, routine: null, template })
            }
          />
        </div>
      </FocusedPageBody>

      <RoutineDialog
        isOpen={dialogState.open}
        routine={dialogState.routine}
        template={dialogState.template}
        onClose={() =>
          setDialogState({ open: false, routine: null, template: null })
        }
      />

      <Dialog
        isOpen={deleteTarget != null}
        onClose={() => setDeleteTarget(null)}
        icon={Trash2}
        title={t("routines.deleteTitle")}
        data-id="delete-routine-dialog"
        buttons={[
          {
            label: t("routines.cancel"),
            variant: "secondary",
            onClick: () => setDeleteTarget(null),
          },
          {
            label: t("routines.delete"),
            variant: "destructive",
            onClick: async () => {
              const target = deleteTarget;
              if (target == null) return true;
              try {
                await removeMutation.mutateAsync(target.id);
              } catch {
                return t("routines.deleteError");
              }
              setDeleteTarget(null);
              return true;
            },
          },
        ]}
      >
        <p className="text-muted-foreground text-sm">
          {t("routines.deleteBody", { name: deleteTarget?.name ?? "" })}
        </p>
      </Dialog>
    </FocusedPage>
  );
};

const StatTile = ({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: number;
  accent?: boolean;
}): JSX.Element => (
  <div className="border-border flex flex-col gap-0.5 rounded-lg border p-3">
    <span
      className={`text-2xl font-semibold ${accent && value > 0 ? "text-primary" : ""}`}
    >
      {value}
    </span>
    <span className="text-muted-foreground text-xs">{label}</span>
  </div>
);

const TRIGGER_BADGE: Record<RoutineTrigger, string> = {
  schedule: "routines.firedBySchedule",
  webhook: "routines.firedByWebhook",
  manual: "routines.firedByManual",
  create: "routines.firedByCreate",
};

const PRESET_LABEL: Record<SchedulePreset, string> = {
  manual: "routines.presetManual",
  once: "routines.presetOnce",
  hourly: "routines.presetHourly",
  daily: "routines.presetDaily",
  weekdays: "routines.presetWeekdays",
  weekly: "routines.presetWeekly",
  custom: "routines.presetCustom",
};

/**
 * "Weekdays at 9:00 AM" for the card; crons the presets cannot name stay as
 * the raw expression.
 */
export const describeSchedule = (
  schedule: string | null,
  runAt: number | null,
  t: (key: string, options?: Record<string, string>) => string,
  language: string
): string => {
  if (runAt != null)
    return t("routines.scheduleOnce", {
      when: new Intl.DateTimeFormat(language, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(runAt)),
    });
  const draft = decomposeCron(schedule);
  const time = formatTime(draft.time, language);
  switch (draft.preset) {
    case "manual":
      return t("routines.scheduleManual");
    case "once":
      return t("routines.scheduleManual");
    case "hourly":
      return t("routines.scheduleHourly");
    case "daily":
      return t("routines.scheduleDaily", { time });
    case "weekdays":
      return t("routines.scheduleWeekdays", { time });
    case "weekly":
      return t("routines.scheduleWeekly", {
        day: weekdayName(draft.weekday, language),
        time,
      });
    case "custom":
      return draft.custom;
  }
};

const RoutineCard = ({
  routine,
  onToggle,
  onRun,
  onEdit,
  onDelete,
}: {
  routine: RoutineListItem;
  onToggle: (enabled: boolean) => void;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): JSX.Element => {
  const { t, i18n } = useTranslation();
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <div
      className={`border-border rounded-lg border p-3 ${routine.enabled ? "" : "opacity-60"}`}
      data-id={`routine-card-${routine.id}`}
    >
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium">
              {routine.name}
            </span>
            {routine.botName != null && (
              <Badge variant="secondary">{routine.botName}</Badge>
            )}
            {routine.webhookToken != null && (
              <Globe className="text-muted-foreground size-3.5 shrink-0" />
            )}
          </div>
          <span className="text-muted-foreground line-clamp-2 text-xs">
            {routine.prompt}
          </span>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span data-id={`routine-schedule-${routine.id}`}>
              {describeSchedule(
                routine.schedule,
                routine.runAt,
                t,
                i18n.language
              )}
            </span>
            {routine.nextRunAt != null && (
              <span>
                {t("routines.nextRun", {
                  time: new Date(routine.nextRunAt).toLocaleString(),
                })}
              </span>
            )}
            {routine.lastRunAt != null && (
              <span>
                {t("routines.lastRun", {
                  time: new Date(routine.lastRunAt).toLocaleString(),
                })}
              </span>
            )}
          </div>
          {routine.webhookPublicPending && (
            <span className="text-muted-foreground text-[11px] italic">
              {t("routines.webhookPublicPending")}
            </span>
          )}
          {routine.webhookUrl != null && !routine.webhookPublicPending && (
            <div className="flex min-w-0 items-center gap-1">
              <code className="text-muted-foreground bg-accent/40 min-w-0 truncate rounded px-1.5 py-0.5 text-[11px]">
                {routine.webhookUrl}
              </code>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("routines.copyWebhook")}
                title={t("routines.copyWebhook")}
                data-id={`routine-copy-webhook-${routine.id}`}
                onClick={() => {
                  void navigator.clipboard.writeText(routine.webhookUrl ?? "");
                  toast.success(t("routines.webhookCopied"), {
                    id: "webhook-copy",
                  });
                }}
              >
                <Copy />
              </Button>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("routines.runNow")}
            title={t("routines.runNow")}
            data-id={`routine-run-${routine.id}`}
            onClick={onRun}
          >
            <Play />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("routines.edit")}
            title={t("routines.edit")}
            data-id={`routine-edit-${routine.id}`}
            onClick={onEdit}
          >
            <Pencil />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("routines.delete")}
            title={t("routines.delete")}
            data-id={`routine-delete-${routine.id}`}
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
          <Switch
            checked={routine.enabled}
            onCheckedChange={onToggle}
            aria-label={t("routines.enabled")}
            data-id={`routine-enabled-${routine.id}`}
          />
        </div>
      </div>

      {routine.runs.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
            data-id={`routine-history-${routine.id}`}
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <ChevronDown
              className={`size-3 transition-transform ${historyOpen ? "rotate-180" : ""}`}
            />
            {t("routines.runHistory", { count: routine.runs.length })}
          </button>
          {historyOpen && (
            <ul className="mt-1 flex flex-col gap-0.5">
              {routine.runs.map((run) => (
                <li
                  key={`${run.at}-${run.trigger}`}
                  className="text-muted-foreground flex items-baseline gap-2 text-xs"
                >
                  <span className="shrink-0 tabular-nums">
                    {new Date(run.at).toLocaleString()}
                  </span>
                  <Badge variant="outline">
                    {t(TRIGGER_BADGE[run.trigger])}
                  </Badge>
                  <span className="min-w-0 truncate">{run.result}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

const templateNameKey = (template: RoutineTemplate): string =>
  `routines.templates.${template.id}.name`;

/**
 * Template shelf, shown under the list rather than only when it is empty:
 * the second routine is as hard to think of as the first.
 */
const RoutineTemplateShelf = ({
  onPick,
}: {
  onPick: (template: RoutineTemplate) => void;
}): JSX.Element => {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-2" data-id="routine-templates">
      <span className="text-muted-foreground text-xs">
        {t("routines.templatesLead")}
      </span>
      <div className="grid gap-2 @2xl:grid-cols-2">
        {ROUTINE_TEMPLATES.map((template) => {
          const Icon = template.icon;
          return (
            <button
              key={template.id}
              type="button"
              onClick={() => onPick(template)}
              data-id={`routine-template-${template.id}`}
              className="border-border hover:bg-accent/50 flex flex-col gap-1 rounded-lg border p-3 text-start transition-colors"
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <Icon className="text-muted-foreground size-4 shrink-0" />
                {t(templateNameKey(template))}
              </span>
              <span className="text-muted-foreground text-xs">
                {t(`routines.templates.${template.id}.description`)}
              </span>
              {/* What it reads from, said up front: a routine that can only
                  report that it cannot reach Gmail is worse than no template. */}
              {template.works != null && (
                <span className="text-muted-foreground/70 text-xs">
                  {t("routines.templateWorksWith", {
                    names: template.works.join(" · "),
                  })}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

/** Not a workspace id: the option that opens the folder dialog. */
const CHOOSE_FOLDER = "__choose__";

/** What the folder field calls a workspace: its folder name, or its label. */
export const workspaceName = (
  workspace: { kind?: string; path?: string | null; label?: string | null },
  t: (key: string) => string
): string => {
  if (workspace.kind === "auto") return t("workspace.autoWorkspace");
  const path = workspace.path ?? "";
  const base = path.split(/[/\\]/).filter(Boolean).at(-1);
  return base ?? workspace.label ?? path;
};

export const RoutineDialog = ({
  isOpen,
  routine,
  template,
  onClose,
}: {
  isOpen: boolean;
  routine: RoutineListItem | null;
  template?: RoutineTemplate | null;
  onClose: () => void;
}): JSX.Element => {
  const { t, i18n } = useTranslation();
  const createMutation = useCreateRoutineMutation();
  const updateMutation = useUpdateRoutineMutation();
  const runMutation = useRunRoutineMutation();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState<ScheduleDraft>(DEFAULT_SCHEDULE);
  const patchSchedule = (patch: Partial<ScheduleDraft>): void =>
    setSchedule((current) => ({ ...current, ...patch }));
  const [webhookOn, setWebhookOn] = useState(false);
  // On by default for new routines; off for edits, which are not a new setup.
  const [testRunOn, setTestRunOn] = useState(true);
  // "" is the routine's own folder, which is what a routine with no project
  // has always run in.
  const [workspaceId, setWorkspaceId] = useState("");
  const metadataQuery = useWorkspaceMetadataQuery();
  const activeWorkspaceId = useWorkspaceActiveWorkspaceId();
  // A routine's own folder is a place for its runs to stand, not a project;
  // it is never offered, the way the workspace picker never offers one.
  const projects = useMemo(
    () =>
      (metadataQuery.data?.workspaces ?? []).filter(
        (workspace) =>
          // The app's own folders are not projects: a run pointed at one is
          // sent to the routine's own folder anyway, so offering them would
          // be a choice that does nothing.
          workspace.kind !== "routine" &&
          workspace.kind !== "auto" &&
          workspace.kind !== "bot" &&
          workspace.status !== "deleted"
      ),
    [metadataQuery.data]
  );
  const queryClient = useQueryClient();

  /**
   * Add a folder from here rather than sending the user to the workspace
   * picker and back: with no project open the list is one option long, and
   * the instruction they just wrote is about a repository.
   */
  const chooseFolder = async (): Promise<void> => {
    const picked = await window.api.openFolderDialog();
    if (picked == null) return;
    const added = await window.api.agent.addWorkspace(picked, false);
    if (added.success !== true || added.workspaceId == null) {
      toast.error(added.error ?? t("routines.workspaceAddError"));
      return;
    }
    await queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.metadata,
    });
    setWorkspaceId(added.workspaceId);
  };

  useEffect(() => {
    if (!isOpen) return;
    // A template seeds a new routine's fields but never overrides one being
    // edited.
    const draft = routine == null ? (template ?? null) : null;
    setName(routine?.name ?? (draft == null ? "" : t(templateNameKey(draft))));
    setPrompt(routine?.prompt ?? draft?.prompt ?? "");
    if (routine != null)
      setSchedule(decomposeSchedule(routine.schedule, routine.runAt));
    else if (draft != null)
      setSchedule({
        ...DEFAULT_SCHEDULE,
        preset: draft.preset,
        time: draft.time,
      });
    else setSchedule(DEFAULT_SCHEDULE);
    setWebhookOn(routine?.webhookToken != null);
    setTestRunOn(routine == null);
    // A template that reads a repository or a test suite gets the open
    // project, since its own folder holds neither.
    setWorkspaceId(
      routine != null
        ? (routine.workspaceId ?? "")
        : draft?.needsWorkspace === true
          ? (activeWorkspaceId ?? "")
          : ""
    );
  }, [isOpen, routine, template, t, activeWorkspaceId]);

  // Said, not enforced: the instruction reads a repository or a test suite and
  // no project is chosen, so the run would happen in a folder holding neither.
  const needsProject =
    routine == null && template?.needsWorkspace === true && workspaceId === "";

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      icon={AlarmClock}
      title={
        routine == null ? t("routines.createTitle") : t("routines.editTitle")
      }
      data-id="routine-dialog"
      buttons={[
        {
          label: t("routines.cancel"),
          variant: "secondary",
          onClick: onClose,
        },
        {
          label: routine == null ? t("routines.create") : t("routines.save"),
          variant: "default",
          onClick: async () => {
            if (prompt.trim().length === 0) return t("routines.promptRequired");
            const { schedule: cron, runAt } = composeSchedule(schedule);
            if (schedule.preset === "custom" && cron == null)
              return t("routines.scheduleRequired");
            if (schedule.preset === "once") {
              if (runAt == null) return t("routines.runAtRequired");
              if (runAt <= Date.now()) return t("routines.runAtPast");
            }
            try {
              if (routine == null) {
                const created = await createMutation.mutateAsync({
                  name: name.trim(),
                  prompt: prompt.trim(),
                  schedule: cron,
                  runAt,
                  webhook: webhookOn,
                  workspaceId: workspaceId.length > 0 ? workspaceId : null,
                });
                // The test run's failure is the routine's to show, not the
                // dialog's to block on.
                if (testRunOn)
                  void runMutation
                    .mutateAsync({ id: created.id, trigger: "create" })
                    .catch(() => undefined);
              } else {
                await updateMutation.mutateAsync({
                  id: routine.id,
                  changes: {
                    name: name.trim(),
                    prompt: prompt.trim(),
                    schedule: cron ?? "",
                    runAt,
                    webhook: webhookOn,
                    workspaceId: workspaceId.length > 0 ? workspaceId : null,
                  },
                });
              }
            } catch (error) {
              return error instanceof Error
                ? error.message
                : t("routines.saveError");
            }
            onClose();
            return true;
          },
        },
      ]}
    >
      <div className="flex max-h-[60vh] flex-col gap-3 overflow-x-hidden overflow-y-auto pe-1">
        <Field>
          <FieldLabel htmlFor="routine-name">
            {t("routines.nameLabel")}
          </FieldLabel>
          <Input
            id="routine-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("routines.namePlaceholder")}
            data-id="routine-name-input"
            autoFocus
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="routine-prompt">
            {t("routines.promptLabel")}
          </FieldLabel>
          <Textarea
            id="routine-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t("routines.promptPlaceholder")}
            data-id="routine-prompt-input"
            rows={3}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="routine-workspace">
            {t("routines.workspaceLabel")}
          </FieldLabel>
          <NativeSelect
            id="routine-workspace"
            value={workspaceId}
            onChange={(event) => {
              const picked = event.target.value;
              // The picker's own value is an action, not a folder: it opens
              // the file dialog and the folder it returns becomes the choice.
              if (picked === CHOOSE_FOLDER) {
                void chooseFolder();
                return;
              }
              setWorkspaceId(picked);
            }}
            data-id="routine-workspace-select"
          >
            <NativeSelectOption value="">
              {t("routines.workspaceOwnFolder")}
            </NativeSelectOption>
            {projects.map((workspace) => (
              <NativeSelectOption key={workspace.id} value={workspace.id}>
                {workspaceName(workspace, t)}
              </NativeSelectOption>
            ))}
            <NativeSelectOption value={CHOOSE_FOLDER}>
              {t("routines.workspaceChoose")}
            </NativeSelectOption>
          </NativeSelect>
          <span
            className={
              needsProject
                ? "text-destructive text-xs"
                : "text-muted-foreground text-xs"
            }
            data-id={needsProject ? "routine-workspace-warning" : undefined}
          >
            {needsProject
              ? t("routines.workspaceMissing")
              : t("routines.workspaceHelp")}
          </span>
        </Field>

        <Field>
          <FieldLabel>{t("routines.scheduleLabel")}</FieldLabel>
          <ToggleGroup
            value={[schedule.preset]}
            onValueChange={(values) => {
              const next = values.at(-1) as SchedulePreset | undefined;
              if (next != null) patchSchedule({ preset: next });
            }}
            variant="outline"
            spacing={0}
            className="w-full"
            aria-label={t("routines.scheduleLabel")}
            data-id="routine-preset-group"
          >
            {SCHEDULE_PRESETS.map((preset) => (
              <ToggleGroupItem
                key={preset}
                value={preset}
                className="min-w-0 flex-1"
                data-id={`routine-preset-${preset}`}
              >
                {t(PRESET_LABEL[preset])}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          {schedule.preset === "once" && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label htmlFor="routine-run-at">{t("routines.runAtLabel")}</label>
              <Input
                id="routine-run-at"
                type="datetime-local"
                value={schedule.runAt}
                min={toLocalDateTime(Date.now())}
                onChange={(event) =>
                  patchSchedule({ runAt: event.target.value })
                }
                className="w-56"
                data-id="routine-run-at-input"
              />
            </div>
          )}

          {presetHasTime(schedule.preset) && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label htmlFor="routine-time">{t("routines.atLabel")}</label>
              <Input
                id="routine-time"
                type="time"
                value={schedule.time}
                onChange={(event) =>
                  patchSchedule({ time: event.target.value })
                }
                className="w-32"
                data-id="routine-time-input"
              />
              {schedule.preset === "weekly" && (
                <>
                  <span>{t("routines.onLabel")}</span>
                  <Select
                    value={String(schedule.weekday)}
                    onValueChange={(value) => {
                      if (value != null)
                        patchSchedule({ weekday: Number(value) as Weekday });
                    }}
                  >
                    <SelectTrigger
                      className="w-36"
                      aria-label={t("routines.onLabel")}
                      data-id="routine-weekday-select"
                    >
                      <SelectValue>
                        {weekdayName(schedule.weekday, i18n.language)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {WEEKDAYS.map((weekday) => (
                        <SelectItem key={weekday} value={String(weekday)}>
                          {weekdayName(weekday, i18n.language)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              )}
            </div>
          )}

          {schedule.preset === "custom" && (
            <Field>
              <FieldLabel htmlFor="routine-cron">
                {t("routines.cronLabel")}
              </FieldLabel>
              <Input
                id="routine-cron"
                type="text"
                value={schedule.custom}
                onChange={(event) =>
                  patchSchedule({ custom: event.target.value })
                }
                placeholder="0 9 * * 1-5"
                className="font-mono"
                data-id="routine-cron-input"
              />
            </Field>
          )}

          <span className="text-muted-foreground text-xs">
            {schedule.preset === "manual"
              ? t("routines.scheduleManualHint")
              : schedule.preset === "once"
                ? t("routines.scheduleOnceHint")
                : t("routines.scheduleHint")}
          </span>
        </Field>

        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col">
            <span className="text-sm font-medium">
              {t("routines.webhookLabel")}
            </span>
            <span className="text-muted-foreground text-xs">
              {t("routines.webhookHint")}
            </span>
          </div>
          <Switch
            checked={webhookOn}
            onCheckedChange={setWebhookOn}
            aria-label={t("routines.webhookLabel")}
            data-id="routine-webhook-toggle"
          />
        </div>

        {routine == null && (
          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-col">
              <span className="text-sm font-medium">
                {t("routines.testRunLabel")}
              </span>
              <span className="text-muted-foreground text-xs">
                {t("routines.testRunHint")}
              </span>
            </div>
            <Switch
              checked={testRunOn}
              onCheckedChange={setTestRunOn}
              aria-label={t("routines.testRunLabel")}
              data-id="routine-test-run-toggle"
            />
          </div>
        )}

        <span className="text-muted-foreground text-xs">
          {t("routines.runsInHint")}
        </span>
      </div>
    </Dialog>
  );
};
