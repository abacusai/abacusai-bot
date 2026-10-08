import {
  MAX_BOT_NAME,
  MAX_BOT_PERSONA,
  MAX_BOT_DESCRIPTION,
  MAX_BOT_TITLE,
  MAX_BOTS,
} from "@abacus-ai/contract/bots";
import type { BotRow } from "@abacus-ai/contract/contract/rows";
import { revalidateLogic, useStore } from "@tanstack/react-form";
import { useBlocker } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { useAppForm } from "#renderer/components/form-kit";
import { useDb } from "#renderer/data/db";
import { accentVars } from "#renderer/lib/bots/avatar";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { showError } from "#renderer/lib/toast";
import { useMediaQuery } from "#renderer/lib/use-media-query";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "#renderer/ui/alert-dialog";
import { Button } from "#renderer/ui/button";
import { Field, FieldLabel, FieldGroup } from "#renderer/ui/field";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  PopoverTitle,
} from "#renderer/ui/popover";

import { BotFace } from "../avatar";
import { BotGone } from "../chat/identity";
import { CheckInFields } from "../check-in/fields";
import { saveErrorOf } from "../data/bot-actions";
import { useBot, useCheckIn } from "../data/queries";
import { useBotsTransport } from "../data/transport";
import { ModelPicker, useBotModelBinding } from "../model/picker";
import {
  getDraft,
  useBotDraft,
  updateDraft,
  clearDraft,
  editDraftStore,
  clearEditDraft,
  subscribeDraft,
} from "./draft-store";
import { LookPicker } from "./look-picker";
import {
  BotFormSchema,
  valuesForBot,
  equalValue,
  type BotFormValues,
} from "./schema";
import { submitCreate, submitEdit } from "./submit";
interface BotFormProps {
  bot?: BotRow;
  initial: BotFormValues;
  load(sessionId: string): Promise<unknown>;
}
const BotForm = ({ bot, initial, load }: BotFormProps) => {
  const { t } = useTranslation();
  const wide = useMediaQuery("(min-width: 1000px)");
  const db = useDb();
  const transport = useBotsTransport();
  const navigate = useAppNavigate();
  const routine = useCheckIn(bot?.id ?? "");
  const [baseline] = useState(() =>
    structuredClone(
      bot ? (editDraftStore.state[bot.id]?.baseline ?? initial) : initial
    )
  );
  const [startingValues] = useState(() =>
    bot ? (editDraftStore.state[bot.id]?.values ?? initial) : initial
  );

  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const form = useAppForm({
    defaultValues: startingValues,
    validationLogic: revalidateLogic({
      mode: "blur",
      modeAfterSubmission: "change",
    }),
    validators: { onDynamic: BotFormSchema },
    onSubmit: async ({ value }) => {
      setError(null);
      if (
        !bot &&
        db.collections.bots.size >= MAX_BOTS &&
        !getDraft().stages.bot
      ) {
        setError(t("bots.errors.limit"));
        return;
      }
      const parsed = v.parse(BotFormSchema, value);
      saving.current = true;
      const deps = {
        db,
        transport,
        load,
        routineName: t("bots.checkIn.routineName", { name: parsed.name }),
        checkInFailed: (retry: () => Promise<void>) =>
          showError(t("bots.checkIn.createFailed"), {
            action: {
              label: t("bots.errors.retry"),
              onClick: () =>
                void retry().catch(() => showError(t("bots.checkIn.error"))),
            },
          }),
        navigate: async (botId: string) => {
          if (!bot) clearDraft();
          else clearEditDraft(bot.id);
          await navigate({
            to: "/bots/$botId",
            params: { botId },
            transition: bot ? "nav-back" : "nav-forward",
          });
        },
      };
      try {
        if (bot) await submitEdit(deps, bot, routine, parsed, baseline);
        else await submitCreate(deps, getDraft(), parsed, updateDraft);
      } catch (cause) {
        saving.current = false;
        const failure = saveErrorOf(cause);
        if (failure.kind === "not-found") {
          await navigate({ to: "/bots/new", replace: true });
          return;
        }
        setError(
          failure.kind === "limit"
            ? t("bots.errors.limit")
            : failure.kind === "bad-request" && failure.field === "name"
              ? t("bots.form.validation.required")
              : t("bots.form.saveError")
        );
      }
    },
  });
  const name = useStore(form.store, (s) => s.values.name);
  const description = useStore(form.store, (s) => s.values.description);
  const look = useStore(form.store, (s) => s.values.look);
  const model = useStore(form.store, (s) => s.values.model);
  const changed =
    bot != null && !equalValue(valuesForBot(bot, routine), baseline);
  const dirty = useStore(form.store, (s) => !equalValue(s.values, baseline));
  const binding = useBotModelBinding(model, (next) =>
    form.setFieldValue("model", next)
  );
  const blocker = useBlocker({
    shouldBlockFn: () => !!bot && dirty && !saving.current,
    withResolver: true,
  });
  useEffect(() => {
    if (!bot) return;
    const next = valuesForBot(bot, routine);
    for (const group of ["look", "checkIn"] as const) {
      const current = form.getFieldValue(group);
      const merged = { ...current };
      const nextBaseline = { ...baseline[group] };
      for (const leaf of Object.keys(current)) {
        const key = leaf as keyof typeof current;
        if (equalValue(current[key], baseline[group][key])) {
          Object.assign(merged, { [leaf]: next[group][key] });
          Object.assign(nextBaseline, { [leaf]: next[group][key] });
        }
      }
      if (!equalValue(current, merged))
        form.setFieldValue(group, merged as never, {
          dontUpdateMeta: true,
          dontValidate: true,
          dontRunListeners: true,
        });
      Object.assign(baseline, { [group]: nextBaseline });
    }
    for (const key of Object.keys(next) as Array<keyof BotFormValues>) {
      if (key === "look" || key === "checkIn") continue;
      if (equalValue(form.getFieldValue(key), baseline[key])) {
        if (!equalValue(next[key], baseline[key])) {
          form.setFieldValue(key, next[key], {
            dontUpdateMeta: true,
            dontValidate: true,
            dontRunListeners: true,
          });
          Object.assign(baseline, { [key]: next[key] });
        }
      }
    }
  }, [bot, routine, form, baseline]);
  useEffect(() => {
    const subscription = form.store.subscribe(() => {
      if (!bot) updateDraft({ values: form.state.values });
      else if (!saving.current)
        editDraftStore.setState((state) => ({
          ...state,
          [bot.id]: { values: form.state.values, baseline },
        }));
    });
    const restoreNew = subscribeDraft((draft) => {
      if (!bot && draft && !equalValue(draft.values, form.state.values))
        form.reset(draft.values);
    });
    const restore = editDraftStore.subscribe(() => {
      const draft = bot && editDraftStore.state[bot.id];
      if (draft && !equalValue(draft.values, form.state.values)) {
        Object.assign(baseline, structuredClone(draft.baseline));
        form.reset(draft.values);
      }
    });
    return () => {
      subscription.unsubscribe();
      restoreNew();
      restore.unsubscribe();
    };
  }, [bot, form, baseline]);
  return (
    <form
      className="flex size-full min-h-0 min-w-0 flex-col overflow-hidden [container:bot-form/inline-size]"
      style={accentVars(look)}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <div className="bot-form-columns flex min-h-0 min-w-0 flex-1 overflow-y-auto">
        <aside className="bg-muted/40 flex w-[300px] min-w-0 shrink-0 flex-col items-center gap-3 px-6 pt-10 text-center">
          <BotFace morph look={look} size={wide ? 96 : 56} mood="happy" />
          <h2 className="max-w-full text-base font-semibold [overflow-wrap:anywhere]">
            {name}
          </h2>
          <p className="text-muted-foreground max-w-full text-center text-xs [overflow-wrap:anywhere]">
            {description}
          </p>
          <form.AppField name="look">
            {(field) =>
              wide ? (
                <LookPicker
                  value={field.state.value}
                  onChange={field.handleChange}
                />
              ) : (
                <Popover>
                  <PopoverTrigger
                    render={<Button variant="secondary" size="sm" />}
                  >
                    {t("bots.form.shape")} / {t("bots.form.colour")}
                  </PopoverTrigger>
                  <PopoverContent>
                    <PopoverTitle>
                      {t("bots.form.shape")} / {t("bots.form.colour")}
                    </PopoverTitle>
                    <LookPicker
                      value={field.state.value}
                      onChange={field.handleChange}
                    />
                  </PopoverContent>
                </Popover>
              )
            }
          </form.AppField>
        </aside>
        <div className="min-w-0 flex-1 p-5 [@container_bot-form_(min-width:900px)]:px-8">
          <FieldGroup>
            {(
              [
                ["name", "bots.form.name", MAX_BOT_NAME, false],
                ["persona", "bots.form.persona", MAX_BOT_PERSONA, true],
                [
                  "instructions",
                  "bots.form.instructions",
                  MAX_BOT_DESCRIPTION,
                  true,
                ],
                ["description", "bots.form.description", MAX_BOT_TITLE, false],
              ] as const
            ).map(([field, label, max, multiline]) => (
              <form.AppField key={field} name={field}>
                {(api) => (
                  <api.TextField
                    label={t(label)}
                    max={max}
                    multiline={multiline}
                  />
                )}
              </form.AppField>
            ))}
            <form.AppField name="checkIn">
              {(field) => (
                <CheckInFields
                  value={field.state.value}
                  onChange={field.handleChange}
                  onBlur={field.handleBlur}
                  {...(routine ? { routineId: routine.id } : {})}
                />
              )}
            </form.AppField>
            <Field>
              <FieldLabel>{t("bots.form.model")}</FieldLabel>
              <ModelPicker binding={binding} />
            </Field>
          </FieldGroup>
        </div>
      </div>
      <footer className="bg-background flex shrink-0 flex-wrap items-center justify-end gap-2 border-t p-4">
        {changed && (
          <p role="status" className="text-muted-foreground mr-auto text-xs">
            {t("bots.form.remoteChange")}
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
        <Button
          variant="ghost"
          onClick={() =>
            void navigate({
              to: bot ? "/bots/$botId" : "/bots/new",
              ...(bot ? { params: { botId: bot.id } } : {}),
              transition: "nav-back",
            })
          }
        >
          {t("bots.form.cancel")}
        </Button>
        <form.AppForm>
          <form.SubmitButton
            label={t(bot ? "bots.form.save" : "bots.form.create")}
          />
        </form.AppForm>
      </footer>
      <AlertDialog open={blocker.status === "blocked"}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("bots.form.discardTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("bots.form.discardBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              autoFocus
              variant="secondary"
              onClick={() => blocker.reset?.()}
            >
              {t("bots.form.keepEditing")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (bot) clearEditDraft(bot.id);
                blocker.proceed?.();
              }}
            >
              {t("bots.form.discard")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
};
export const BotSetupForm = ({
  load,
}: {
  load(sessionId: string): Promise<unknown>;
}) => {
  const draft = useBotDraft();
  return <BotForm initial={draft.values} load={load} />;
};
export const BotEditorPage = ({
  botId,
  load,
}: {
  botId: string;
  load(sessionId: string): Promise<unknown>;
}) => {
  const bot = useBot(botId);
  const routine = useCheckIn(botId);
  if (!bot) return <BotGone />;
  return <BotForm bot={bot} initial={valuesForBot(bot, routine)} load={load} />;
};
