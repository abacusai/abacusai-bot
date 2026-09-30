import { revalidateLogic } from "@tanstack/react-form";
import { useRouter, useBlocker } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { useAppForm } from "#next/components/form-kit";
import { Segments } from "#next/components/form-kit/controls";
import { usePrefs } from "#next/data/db/prefs";
import {
  composeSchedule,
  WEEKDAYS,
  weekdayName,
} from "#next/lib/bots/schedule";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { ROUTINE_TEMPLATES } from "#next/lib/routines/templates";
import { showError } from "#next/lib/toast";
import { useAppContext, rpcError } from "#next/lib/use-app-context";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "#next/ui/alert-dialog";
import { Button } from "#next/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "#next/ui/dialog";
import { Field, FieldLabel, FieldGroup, FieldError } from "#next/ui/field";
import { Input } from "#next/ui/input";
import { NativeSelect, NativeSelectOption } from "#next/ui/native-select";
import { Switch } from "#next/ui/switch";
import type { RoutineRow } from "#shared/contract/rows";

import { useRoutinesData } from "./data";
import {
  RoutineFormSchema,
  valuesForRoutine,
  dirtyPatch,
  nextPreview,
} from "./schema";
export const RoutineDialog = ({
  routineId,
  template,
}: {
  routineId?: string;
  template?: string;
}) => {
  const { t, i18n } = useTranslation();
  const { db, transport } = useAppContext();
  const router = useRouter();
  const navigate = useAppNavigate();
  const prefs = usePrefs();
  const { routines, workspaces } = useRoutinesData();
  const row = routines.find((r) => r.id === routineId);
  const initial = valuesForRoutine(row);
  const picked = ROUTINE_TEMPLATES.find((x) => x.id === template);
  if (!routineId && picked) {
    initial.prompt = picked.prompt;
    initial.name = t(`routines.templates.${picked.id}.name`);
    initial.schedule = {
      ...initial.schedule,
      preset: picked.preset,
      time: picked.time,
    };
    initial.workspaceId = picked.needsWorkspace
      ? prefs.lastPickedWorkspaceId
      : null;
  }
  const baseline = useRef(initial);
  const [remote, setRemote] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [replacement, setReplacement] = useState<
    (typeof ROUTINE_TEMPLATES)[number] | null
  >(null);
  const discarded = useRef(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState(() => `routine-${crypto.randomUUID()}`);
  const close = () => {
    if (router.history.canGoBack()) router.history.back();
    else
      void navigate({
        to: routineId ? "/routines/$routineId" : "/routines",
        params: routineId ? { routineId } : {},
        replace: true,
        transition: "none",
      });
  };
  const form = useAppForm({
    defaultValues: initial,
    validationLogic: revalidateLogic({
      mode: "blur",
      modeAfterSubmission: "change",
    }),
    validators: { onDynamic: RoutineFormSchema },
    onSubmit: async ({ value }) => {
      const parsed = v.parse(RoutineFormSchema, value);
      setError(null);
      try {
        if (routineId) {
          await db.collections.routines.update(routineId, (d) =>
            Object.assign(d, dirtyPatch(parsed, baseline.current))
          ).isPersisted.promise;
          baseline.current = parsed;
          close();
          return;
        }
        const insert = async (newId: string) => {
          const now = Date.now();
          const optimistic: RoutineRow = {
            id: newId,
            name: parsed.name,
            prompt: parsed.prompt,
            ...composeSchedule(parsed.schedule),
            workspaceId: parsed.workspaceId,
            botId: null,
            enabled: true,
            createdAt: now,
            lastRunAt: null,
            lastResult: null,
            recentRuns: [],
            nextRunAt: null,
            webhookToken: parsed.webhook ? "pending" : null,
            webhookUrl: null,
            webhookPublicPending: parsed.webhook,
            botName: null,
          };
          await db.collections.routines.insert(optimistic).isPersisted.promise;
        };
        const savedId = await insertWithConflictRetry(insert, id);
        if (savedId !== id) setId(savedId);
        baseline.current = parsed;
        if (parsed.testRun)
          void transport.client.routines
            .run({ id: savedId, trigger: "create" })
            .catch(() => showError(t("phase5.firstRunFailed")));
        await navigate({
          to: "/routines/$routineId",
          params: { routineId: savedId },
          replace: true,
          transition: "nav-forward",
        });
      } catch (e) {
        if (
          rpcError(e)?.code === "BAD_REQUEST" &&
          rpcError(e)?.data.field === "schedule"
        ) {
          setScheduleError(
            String(rpcError(e)?.data.detail ?? t("phase5.mainScheduleError"))
          );
          return;
        }
        setError(
          rpcError(e)?.code === "BAD_REQUEST"
            ? t("phase5.mainScheduleError") +
                " " +
                String(rpcError(e)?.data.detail ?? "")
            : t("phase5.saveRoutineFailed")
        );
      }
    },
  });
  const changed = () =>
    JSON.stringify(form.state.values) !== JSON.stringify(baseline.current);
  const applyTemplate = (x: (typeof ROUTINE_TEMPLATES)[number]) => {
    form.setFieldValue("name", t(`routines.templates.${x.id}.name`));
    form.setFieldValue("prompt", x.prompt);
    form.setFieldValue("schedule", {
      ...form.state.values.schedule,
      preset: x.preset,
      time: x.time,
    });
    form.setFieldValue(
      "workspaceId",
      x.needsWorkspace ? prefs.lastPickedWorkspaceId : null
    );
  };
  const blocker = useBlocker({
    shouldBlockFn: () => !discarded.current && changed(),
    withResolver: true,
  });
  useEffect(() => {
    if (!row) return;
    const incoming = valuesForRoutine(row);
    let conflict = false;
    for (const key of [
      "name",
      "prompt",
      "schedule",
      "workspaceId",
      "webhook",
    ] as const) {
      if (
        JSON.stringify(incoming[key]) === JSON.stringify(baseline.current[key])
      )
        continue;
      if (
        JSON.stringify(form.state.values[key]) ===
        JSON.stringify(baseline.current[key])
      ) {
        form.setFieldValue(key, incoming[key], {
          dontUpdateMeta: true,
          dontValidate: true,
          dontRunListeners: true,
        });
      } else conflict = true;
      Object.assign(baseline.current, { [key]: incoming[key] });
    }
    // Remote collection changes are external form-baseline events.
    // eslint-disable-next-line react/set-state-in-effect
    if (conflict) setRemote(true);
  }, [row, form]);
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) {
            if (changed()) setDiscardOpen(true);
            else close();
          }
        }}
      >
        <DialogContent
          className="max-h-[calc(100vh-48px)] overflow-auto rounded-2xl p-5 sm:max-w-[640px]"
          data-testid="routine-dialog"
        >
          <DialogHeader>
            <DialogTitle>
              {t(routineId ? "phase5.editRoutine" : "phase5.createRoutine")}
            </DialogTitle>
            <DialogDescription>{t("phase5.freshSession")}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
          >
            <FieldGroup>
              <form.AppField name="name">
                {(f) => (
                  <f.TextField
                    label={t("phase5.name")}
                    max={80}
                    errorKeyPrefix="phase5.validation"
                  />
                )}
              </form.AppField>
              <form.AppField name="prompt">
                {(f) => (
                  <f.TextField
                    label={t("phase5.instruction")}
                    errorKeyPrefix="phase5.validation"
                    max={16000}
                    multiline
                  />
                )}
              </form.AppField>
              <form.Subscribe selector={(s) => s.values}>
                {(value) => {
                  const d = value.schedule;
                  const preview = nextPreview(d, new Date());
                  return (
                    <>
                      <Field>
                        <FieldLabel>{t("phase5.scheduleLabel")}</FieldLabel>
                        <Segments
                          label={t("phase5.scheduleLabel")}
                          value={d.preset}
                          values={[
                            "hourly",
                            "daily",
                            "weekdays",
                            "weekly",
                            "once",
                            "manual",
                            "custom",
                          ].map((x) => ({
                            value: x,
                            label: t(`phase5.presets.${x}`),
                          }))}
                          onChange={(p) =>
                            form.setFieldValue("schedule", {
                              ...d,
                              preset: p as typeof d.preset,
                            })
                          }
                        />
                        {d.preset === "hourly" ? (
                          <Input
                            aria-label={t("phase5.minute")}
                            type="number"
                            min={0}
                            max={59}
                            value={Number(d.time.split(":")[1])}
                            onChange={(e) =>
                              form.setFieldValue("schedule", {
                                ...d,
                                time: `09:${e.target.value.padStart(2, "0")}`,
                              })
                            }
                          />
                        ) : ["daily", "weekdays", "weekly"].includes(
                            d.preset
                          ) ? (
                          <Input
                            aria-label={t("phase5.at")}
                            type="time"
                            value={d.time}
                            onChange={(e) =>
                              form.setFieldValue("schedule", {
                                ...d,
                                time: e.target.value,
                              })
                            }
                          />
                        ) : d.preset === "once" ? (
                          <Input
                            aria-label={t("phase5.runAt")}
                            type="datetime-local"
                            value={d.runAt}
                            onChange={(e) =>
                              form.setFieldValue("schedule", {
                                ...d,
                                runAt: e.target.value,
                              })
                            }
                          />
                        ) : d.preset === "custom" ? (
                          <Input
                            aria-label={t("phase5.cron")}
                            value={d.custom}
                            onChange={(e) =>
                              form.setFieldValue("schedule", {
                                ...d,
                                custom: e.target.value,
                              })
                            }
                          />
                        ) : null}
                        {d.preset === "weekly" && (
                          <Segments
                            label={t("phase5.weekday")}
                            value={String(d.weekday)}
                            values={WEEKDAYS.map((day) => ({
                              value: String(day),
                              label: weekdayName(day, i18n.language),
                            }))}
                            onChange={(day) =>
                              form.setFieldValue("schedule", {
                                ...d,
                                weekday: Number(day) as typeof d.weekday,
                              })
                            }
                          />
                        )}
                        <form.Field name="schedule">
                          {(field) => (
                            <>
                              {field.state.meta.errors.length > 0 && (
                                <FieldError>
                                  {t("phase5.mainScheduleError")}
                                </FieldError>
                              )}
                              {scheduleError && (
                                <FieldError>{scheduleError}</FieldError>
                              )}
                            </>
                          )}
                        </form.Field>
                        <p className="text-muted-foreground text-xs">
                          {t("phase5.localTime")}
                        </p>
                        {preview && (
                          <p aria-live="polite">
                            {t("phase5.next", {
                              date: new Intl.DateTimeFormat(i18n.language, {
                                dateStyle: "medium",
                                timeStyle: "short",
                              }).format(preview),
                            })}
                          </p>
                        )}
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="routine-folder">
                          {t("phase5.folder")}
                        </FieldLabel>
                        <NativeSelect
                          id="routine-folder"
                          value={value.workspaceId ?? ""}
                          onChange={(e) => {
                            if (e.target.value === "choose") {
                              void transport.client.system.dialog
                                .openFolder({})
                                .then(async (path) => {
                                  if (!path) return;
                                  const added =
                                    await transport.client.workspaces.add({
                                      path,
                                    });
                                  form.setFieldValue(
                                    "workspaceId",
                                    added.workspaceId
                                  );
                                })
                                .catch(() =>
                                  showError(t("phase5.folderFailed"))
                                );
                            } else
                              form.setFieldValue(
                                "workspaceId",
                                e.target.value || null
                              );
                          }}
                        >
                          <NativeSelectOption value="">
                            {t("phase5.ownFolder")}
                          </NativeSelectOption>
                          {workspaces
                            .filter((w) => w.kind == null || w.kind === "auto")
                            .map((w) => (
                              <NativeSelectOption key={w.id} value={w.id}>
                                {w.label ?? w.path}
                              </NativeSelectOption>
                            ))}
                          <NativeSelectOption value="choose">
                            {t("phase5.chooseFolder")}
                          </NativeSelectOption>
                        </NativeSelect>
                      </Field>
                      <Field orientation="horizontal">
                        <FieldLabel htmlFor="routine-webhook">
                          {t("phase5.webhook")}
                        </FieldLabel>
                        <Switch
                          id="routine-webhook"
                          checked={value.webhook}
                          onCheckedChange={(v) =>
                            form.setFieldValue("webhook", v)
                          }
                        />
                      </Field>
                      {!routineId && (
                        <Field orientation="horizontal">
                          <FieldLabel htmlFor="routine-test">
                            {t("phase5.testRun")}
                          </FieldLabel>
                          <Switch
                            id="routine-test"
                            checked={value.testRun}
                            onCheckedChange={(v) =>
                              form.setFieldValue("testRun", v)
                            }
                          />
                        </Field>
                      )}
                    </>
                  );
                }}
              </form.Subscribe>
              {!routineId && (
                <div className="flex flex-wrap gap-1">
                  {ROUTINE_TEMPLATES.map((x) => (
                    <Button
                      key={x.id}
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (changed()) setReplacement(x);
                        else applyTemplate(x);
                      }}
                    >
                      {t(`routines.templates.${x.id}.name`)}
                    </Button>
                  ))}
                </div>
              )}
              {remote && <p role="status">{t("phase5.remoteChanged")}</p>}
              {error && <p role="alert">{error}</p>}
              <form.Subscribe selector={(s) => s.errors}>
                {(errors) =>
                  errors.length > 0 ? (
                    <p role="alert">{t("phase5.invalidRoutine")}</p>
                  ) : null
                }
              </form.Subscribe>
              <DialogFooter>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    if (changed()) setDiscardOpen(true);
                    else close();
                  }}
                >
                  {t("phase5.cancel")}
                </Button>
                <form.AppForm>
                  <form.SubmitButton
                    label={t(routineId ? "phase5.save" : "phase5.create")}
                  />
                </form.AppForm>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!replacement}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("phase5.replaceDraft")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("phase5.discard")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setReplacement(null)}>
              {t("phase5.keepEditing")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (replacement) applyTemplate(replacement);
                setReplacement(null);
              }}
            >
              {t("phase5.replaceDraft")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={discardOpen || blocker.status === "blocked"}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("phase5.discardTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("phase5.discard")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setDiscardOpen(false);
                if (blocker.status === "blocked") blocker.reset();
              }}
            >
              {t("phase5.keepEditing")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                discarded.current = true;
                setDiscardOpen(false);
                if (blocker.status === "blocked") blocker.proceed();
                else close();
              }}
            >
              {t("phase5.discardAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
export const RoutineCreateDialog = () => {
  const router = useRouter();
  return (
    <RoutineDialog
      template={
        (router.state.location.search as { template?: string }).template
      }
    />
  );
};

export const RoutineEditDialog = ({ routineId }: { routineId: string }) => (
  <RoutineDialog routineId={routineId} />
);

async function insertWithConflictRetry(
  insert: (id: string) => Promise<void>,
  id: string
) {
  try {
    await insert(id);
    return id;
  } catch (e) {
    if (rpcError(e)?.code !== "CONFLICT") throw e;
    const retryId = `routine-${crypto.randomUUID()}`;
    await insert(retryId);
    return retryId;
  }
}
