import { revalidateLogic } from "@tanstack/react-form";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { useAppForm } from "#next/components/form-kit";
import { useDb } from "#next/data/db";
import {
  CheckInDraftSchema,
  checkInFromRoutine,
  describeCheckIn,
} from "#next/lib/bots/check-in";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { Button } from "#next/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "#next/ui/dialog";

import { announceChange } from "../data/bot-actions";
import { useBot, useCheckIn } from "../data/queries";
import { useBotsTransport } from "../data/transport";
import { persistCheckIn } from "../form/submit";
import { CheckInFields } from "./fields";
export const CheckInDialog = ({ botId }: { botId: string }) => {
  const { t } = useTranslation();
  const bot = useBot(botId);
  const routine = useCheckIn(botId);
  const db = useDb();
  const transport = useBotsTransport();
  const router = useRouter();
  const navigate = useAppNavigate();
  const [error, setError] = useState(false);
  const close = (): void => {
    if (router.history.canGoBack()) router.history.back();
    else
      void navigate({
        to: "/bots/$botId",
        params: { botId },
        replace: true,
        transition: "none",
      });
  };
  const form = useAppForm({
    defaultValues: checkInFromRoutine(routine),
    validationLogic: revalidateLogic({
      mode: "blur",
      modeAfterSubmission: "change",
    }),
    validators: { onDynamic: CheckInDraftSchema },
    onSubmit: async ({ value }) => {
      if (!bot) return;
      const parsed = v.parse(CheckInDraftSchema, value);
      try {
        await persistCheckIn(
          db,
          bot,
          routine,
          parsed,
          t("bots.checkIn.routineName", { name: bot.name })
        );
        if (
          parsed.preset !== "custom" &&
          (parsed.preset !== checkInFromRoutine(routine).preset ||
            parsed.time !== checkInFromRoutine(routine).time ||
            parsed.weekday !== checkInFromRoutine(routine).weekday)
        )
          announceChange(transport, bot.id, {
            checkIn: describeCheckIn({ ...parsed, preset: parsed.preset }),
          });
        close();
      } catch {
        setError(true);
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
      <DialogContent data-testid="check-in-dialog" className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t("bots.checkIn.label")}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.AppField name="preset">
            {() => (
              <form.Subscribe selector={(s) => s.values}>
                {(value) => (
                  <CheckInFields
                    value={value}
                    onChange={(next) => {
                      for (const key of Object.keys(
                        next
                      ) as (keyof typeof next)[])
                        form.setFieldValue(key, next[key]);
                    }}
                    {...(routine ? { routineId: routine.id } : {})}
                  />
                )}
              </form.Subscribe>
            )}
          </form.AppField>
          {error && <p role="alert">{t("bots.checkIn.error")}</p>}
          <DialogFooter className="mt-4">
            <Button variant="ghost" onClick={close}>
              {t("bots.form.cancel")}
            </Button>
            <form.AppForm>
              <form.SubmitButton label={t("bots.form.save")} />
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
