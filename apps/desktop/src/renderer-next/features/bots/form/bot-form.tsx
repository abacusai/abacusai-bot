import { revalidateLogic, useStore } from "@tanstack/react-form";
import { useBlocker } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { useAppForm } from "#next/components/form-kit";
import { useDb } from "#next/data/db";
import { accentVars } from "#next/lib/bots/avatar";
import { useSharedElementName } from "#next/lib/navigation/shared-element";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { showError } from "#next/lib/toast";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "#next/ui/alert-dialog";
import { Button } from "#next/ui/button";
import { Field, FieldLabel, FieldGroup } from "#next/ui/field";
import {
  MAX_BOT_NAME,
  MAX_BOT_PERSONA,
  MAX_BOT_DESCRIPTION,
  MAX_BOT_TITLE,
  MAX_BOTS,
} from "#shared/bots";
import type { BotRow } from "#shared/contract/rows";

import { BotFace } from "../avatar";
import { BotGone } from "../chat/identity";
import { CheckInFields } from "../check-in/fields";
import { codeOf } from "../data/bot-actions";
import { useBot, useCheckIn } from "../data/queries";
import { useBotsTransport } from "../data/transport";
import { ModelPicker, useBotModelBinding } from "../model/picker";
import { getDraft, useBotDraft, updateDraft, clearDraft } from "./draft-store";
import { LookPicker } from "./look-picker";
import {
  BotFormSchema,
  valuesForBot,
  equalValue,
  type BotFormValues,
} from "./schema";
import { submitCreate, submitEdit } from "./submit";
export interface BotFormProps {
  bot?: BotRow;
  initial: BotFormValues;
  load(sessionId: string): Promise<unknown>;
}
export const BotForm = ({ bot, initial, load }: BotFormProps) => {
  const { t } = useTranslation();
  const db = useDb();
  const transport = useBotsTransport();
  const navigate = useAppNavigate();
  const routine = useCheckIn(bot?.id ?? "");
  const [baseline] = useState(() => ({ ...initial }));

  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const id = bot?.id ?? getDraft().id;
  const shared = useSharedElementName(`bot-identity-${id}`);
  const form = useAppForm({
    defaultValues: initial,
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
        if (codeOf(cause) === "NOT_FOUND") {
          await navigate({ to: "/bots/new", replace: true });
          return;
        }
        setError(
          codeOf(cause) === "PRECONDITION_FAILED"
            ? t("bots.errors.limit")
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
    for (const key of Object.keys(next) as Array<keyof BotFormValues>) {
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
    if (bot) return;
    const subscription = form.store.subscribe(() =>
      updateDraft({ values: form.state.values })
    );
    return () => subscription.unsubscribe();
  }, [bot, form]);
  return (
    <form
      className="flex size-full min-h-0 flex-col overflow-auto"
      style={accentVars(look)}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <div className="bot-form-columns flex flex-1">
        <aside className="bg-muted/40 flex w-[300px] shrink-0 flex-col items-center gap-3 px-6 pt-10">
          <div style={shared}>
            <BotFace look={look} size={96} mood="happy" />
          </div>
          <h2 className="text-base font-semibold">{name}</h2>
          <p className="text-muted-foreground text-center text-xs">
            {description}
          </p>
          <form.AppField name="look">
            {(field) => (
              <LookPicker
                value={field.state.value}
                onChange={field.handleChange}
              />
            )}
          </form.AppField>
        </aside>
        <div className="flex-1 p-8 lg:px-10">
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
      <footer className="flex items-center justify-end gap-2 border-t p-4">
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
            <Button variant="destructive" onClick={() => blocker.proceed?.()}>
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
