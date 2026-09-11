import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  defaultAvatarColor,
  defaultAvatarShape,
  MAX_BOT_NAME,
  MAX_BOT_PERSONA,
  type Bot,
} from "#shared/bots";

import {
  useCreateBotMutation,
  useUpdateBotMutation,
} from "../../hooks/use-bots";
import {
  useCreateRoutineMutation,
  useRemoveRoutineMutation,
  useRoutinesQuery,
  useUpdateRoutineMutation,
} from "../../hooks/use-routines";
import { Dialog } from "../common/dialog";
import {
  composeCron,
  decomposeCron,
  DEFAULT_SCHEDULE,
  presetHasTime,
  WEEKDAYS,
  weekdayName,
  type SchedulePreset,
  type Weekday,
} from "../settings/routine-schedule";
import { Field, FieldLabel, Input, Textarea } from "../ui";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible";
import { NativeSelect, NativeSelectOption } from "../ui/native-select";
import { BotAvatarPicker, type BotAvatarLook } from "./bot-avatar-picker";
import type { BotTemplate } from "./bot-templates";

/**
 * Make a bot: who it is, how it speaks, what it does. Persona (voice) and
 * instructions (mission) are separate fields because one changes without the
 * other; a bot with only a name still works. "More options" holds a description
 * and scheduled check-ins, a routine on the bot. A template opens this same
 * dialog prefilled, and editing is this same form too; when an edit changes the
 * mission, persona or schedule, the bot's chat is told once.
 */

/** The standing instruction a bot with no instructions starts with. */
export const NAME_ONLY_MISSION = [
  "Your mission is not set yet — take your best cue from your name. In your",
  "first message, say what you guess your lane is, offer two or three concrete",
  "jobs you could take on, and ask the user what they actually want you",
  "handling. Once they tell you, treat that as your standing mission from then",
  "on.",
].join(" ");

/** What a check-in routine asks the bot to do when it fires. */
export const CHECK_IN_PROMPT = [
  "This is your scheduled check-in. Look at what has changed since you last",
  "spoke to the user — anything your mission tracks, anything they asked you",
  "to keep an eye on — and message them with what is worth knowing. If there",
  "is nothing new, say so in one line rather than inventing an update.",
].join(" ");

export type CheckInSchedule = Extract<
  SchedulePreset,
  "hourly" | "daily" | "weekdays" | "weekly"
>;

const CHECK_IN_OPTIONS: readonly (CheckInSchedule | "off")[] = [
  "off",
  "hourly",
  "daily",
  "weekdays",
  "weekly",
];

/** The check-in routine this dialog made for a bot, among the bot's routines. */
const isCheckInRoutine = (
  routine: {
    botId: string | null;
    prompt: string;
  },
  botId: string
): boolean => routine.botId === botId && routine.prompt === CHECK_IN_PROMPT;

/** The schedule in words, for the bot's own ears — English, like its prompt. */
const describeCheckIn = (
  preset: CheckInSchedule | "off",
  time: string,
  weekday: Weekday
): string => {
  switch (preset) {
    case "off":
      return "off";
    case "hourly":
      return "every hour";
    case "daily":
      return `every day at ${time}`;
    case "weekdays":
      return `weekdays at ${time}`;
    case "weekly":
      return `weekly on ${weekdayName(weekday, "en-US")} at ${time}`;
  }
};

export const NewBotDialog = ({
  isOpen,
  initialName = "",
  initialLook = null,
  template = null,
  bot = null,
  title,
  onClose,
  onCreated,
}: {
  isOpen: boolean;
  initialName?: string;
  initialLook?: BotAvatarLook | null;
  template?: BotTemplate | null;
  /** The bot being edited; null makes a new one. */
  bot?: Bot | null;
  /** Header line, when the occasion is neither "new bot" nor "edit bot". */
  title?: string;
  onClose: () => void;
  /** The bot made, or the bot saved. */
  onCreated: (bot: Bot) => void;
}): JSX.Element => {
  const { t, i18n } = useTranslation();
  const createBot = useCreateBotMutation();
  const updateBot = useUpdateBotMutation();
  const createRoutine = useCreateRoutineMutation();
  const updateRoutine = useUpdateRoutineMutation();
  const removeRoutine = useRemoveRoutineMutation();
  const editing = bot != null;
  // The check-in this dialog made; what the bot scheduled itself is left alone.
  const routinesQuery = useRoutinesQuery();
  const existingCheckIn = useMemo(
    () =>
      bot == null
        ? null
        : (routinesQuery.data?.find((routine) =>
            isCheckInRoutine(routine, bot.id)
          ) ?? null),
    [bot, routinesQuery.data]
  );
  // Only models that can run; an unconfigured provider fails on its first token.
  const models = useQuery({
    queryKey: ["bot-dialog-models"],
    queryFn: () => window.api.agent.listModels(),
    enabled: isOpen,
    staleTime: 60_000,
  });
  const configuredModels = (models.data ?? []).filter(
    (entry) => entry.configured
  );

  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [instructions, setInstructions] = useState("");
  const [description, setDescription] = useState("");
  const [checkIn, setCheckIn] = useState<CheckInSchedule | "off">("off");
  // Time of day and, for a weekly one, its day: the routine dialog's two facts.
  const [checkInTime, setCheckInTime] = useState(DEFAULT_SCHEDULE.time);
  const [checkInWeekday, setCheckInWeekday] = useState<Weekday>(
    DEFAULT_SCHEDULE.weekday
  );
  // An untouched schedule is left exactly as it is on save.
  const [checkInTouched, setCheckInTouched] = useState(false);
  const [model, setModel] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  // Null means "whatever the name says": the face follows the name as typed,
  // so the default a bot would get is the one on screen.
  const [pickedLook, setPickedLook] = useState<BotAvatarLook | null>(null);
  const look: BotAvatarLook = pickedLook ??
    (bot == null ? null : { shape: bot.avatarShape, color: bot.avatarColor }) ??
    (template == null
      ? null
      : { shape: template.avatarShape, color: template.avatarColor }) ??
    initialLook ?? {
      shape: defaultAvatarShape(name.trim()),
      color: defaultAvatarColor(name.trim()),
    };

  useEffect(() => {
    if (!isOpen) return;
    setPickedLook(null);
    setName(
      bot != null
        ? bot.name
        : template == null
          ? initialName
          : t(`bots.templates.${template.id}.name`)
    );
    setPersona(bot?.persona ?? template?.persona ?? "");
    setInstructions(bot?.description ?? template?.mission ?? "");
    setDescription(bot?.title ?? template?.title ?? "");
    setModel(bot?.model ?? "");
    setCheckIn("off");
    setCheckInTime(DEFAULT_SCHEDULE.time);
    setCheckInWeekday(DEFAULT_SCHEDULE.weekday);
    setCheckInTouched(false);
    setMoreOpen(false);
  }, [isOpen, initialName, template, bot, t]);

  // Read back once the routines arrive, after the reset above. A schedule this
  // dialog cannot express (a custom cron) shows as off and stays untouched.
  useEffect(() => {
    if (!isOpen || checkInTouched) return;
    if (existingCheckIn == null) return;
    const draft = decomposeCron(existingCheckIn.schedule);
    const preset = (CHECK_IN_OPTIONS as readonly string[]).includes(
      draft.preset
    )
      ? (draft.preset as CheckInSchedule)
      : "off";
    setCheckIn(preset);
    setCheckInTime(draft.time);
    setCheckInWeekday(draft.weekday);
  }, [isOpen, existingCheckIn, checkInTouched]);

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      headerIcon={
        <BotAvatarPicker
          seed={name.trim() || "new-bot"}
          look={look}
          onChange={setPickedLook}
          dataId="new-bot-avatar"
        />
      }
      title={
        title ?? (editing ? t("bots.editTitle") : t("bots.newDialog.title"))
      }
      titleBeforeIcon
      data-id={editing ? "bot-dialog" : "new-bot-dialog"}
      buttons={[
        {
          label: t("bots.cancel"),
          variant: "secondary",
          onClick: onClose,
        },
        {
          label: editing ? t("bots.save") : t("bots.create"),
          variant: "default",
          onClick: async () => {
            const trimmedName = name.trim();
            if (trimmedName.length === 0) return t("bots.nameRequired");
            const mission = instructions.trim();
            const pickedModel = model.trim().length > 0 ? model : null;
            const schedule =
              checkIn === "off"
                ? null
                : composeCron({
                    ...DEFAULT_SCHEDULE,
                    preset: checkIn,
                    time: checkInTime,
                    weekday: checkInWeekday,
                  });
            let saved: Bot;
            try {
              saved =
                bot == null
                  ? await createBot.mutateAsync({
                      name: trimmedName,
                      title: description.trim(),
                      description:
                        mission.length > 0 ? mission : NAME_ONLY_MISSION,
                      persona: persona.trim(),
                      model: pickedModel,
                      // The face on screen is the face the bot gets.
                      avatarColor: look.color,
                      avatarShape: look.shape,
                    })
                  : await updateBot.mutateAsync({
                      id: bot.id,
                      changes: {
                        name: trimmedName,
                        title: description.trim(),
                        description:
                          mission.length > 0 ? mission : NAME_ONLY_MISSION,
                        persona: persona.trim(),
                        model: pickedModel,
                        avatarColor: look.color,
                        avatarShape: look.shape,
                      },
                    });
            } catch {
              return t("bots.saveError");
            }
            // A failed check-in schedule is said out loud, not allowed to sink the bot.
            const checkInChanged =
              bot == null
                ? checkIn !== "off"
                : checkInTouched &&
                  (existingCheckIn?.schedule ?? null) !== schedule;
            if (checkInChanged) {
              try {
                if (existingCheckIn != null && schedule == null) {
                  await removeRoutine.mutateAsync(existingCheckIn.id);
                } else if (existingCheckIn != null) {
                  await updateRoutine.mutateAsync({
                    id: existingCheckIn.id,
                    changes: { schedule, enabled: true },
                  });
                } else {
                  await createRoutine.mutateAsync({
                    name: t("bots.newDialog.checkInRoutineName", {
                      name: trimmedName,
                    }),
                    prompt: CHECK_IN_PROMPT,
                    schedule,
                    botId: saved.id,
                  });
                }
              } catch {
                toast.error(t("bots.newDialog.checkInError"), {
                  id: "bot-check-in",
                });
              }
            }
            // A change to what the bot is for is said in its chat once; a rename is not.
            if (bot != null) {
              const notice = {
                ...(saved.description !== bot.description
                  ? { mission: true }
                  : {}),
                ...(saved.persona !== bot.persona ? { persona: true } : {}),
                ...(checkInChanged
                  ? {
                      checkIn: describeCheckIn(
                        checkIn,
                        checkInTime,
                        checkInWeekday
                      ),
                    }
                  : {}),
              };
              if (Object.keys(notice).length > 0) {
                void window.api.agent
                  .announceBotChange(bot.id, notice)
                  .catch(() => undefined);
              }
            }
            onCreated(saved);
            return true;
          },
        },
      ]}
    >
      <div className="flex max-h-[65vh] flex-col gap-3 overflow-x-hidden overflow-y-auto pe-1">
        <Field>
          <FieldLabel htmlFor="new-bot-name">{t("bots.nameLabel")}</FieldLabel>
          <Input
            id="new-bot-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("bots.newDialog.namePlaceholder")}
            maxLength={MAX_BOT_NAME}
            data-id="new-bot-name-input"
            autoFocus
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="new-bot-persona">
            {t("bots.personaLabel")}
          </FieldLabel>
          <Textarea
            id="new-bot-persona"
            value={persona}
            onChange={(event) => setPersona(event.target.value)}
            placeholder={t("bots.personaPlaceholder")}
            maxLength={MAX_BOT_PERSONA}
            data-id="new-bot-persona-input"
            rows={2}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="new-bot-instructions">
            {t("bots.newDialog.instructionsLabel")}
          </FieldLabel>
          <Textarea
            id="new-bot-instructions"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder={t("bots.newDialog.instructionsPlaceholder")}
            data-id="new-bot-instructions-input"
            rows={4}
          />
        </Field>

        <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
          <CollapsibleTrigger
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
            data-id="new-bot-more-toggle"
          >
            <ChevronRight
              className={`size-3.5 transition-transform ${moreOpen ? "rotate-90" : ""}`}
              aria-hidden="true"
            />
            {t("bots.newDialog.moreOptions")}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 flex flex-col gap-3">
            <Field>
              <FieldLabel htmlFor="new-bot-description">
                {t("bots.newDialog.descriptionLabel")}
              </FieldLabel>
              <Input
                id="new-bot-description"
                type="text"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t("bots.newDialog.descriptionPlaceholder")}
                data-id="new-bot-description-input"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-bot-check-in">
                {t("bots.newDialog.checkInLabel")}
              </FieldLabel>
              <span className="text-muted-foreground text-xs">
                {t("bots.newDialog.checkInHelp")}
              </span>
              {/* Day and time appear only when the frequency has one, so "Off"
                  and "Hourly" stay a single control. */}
              <div className="flex flex-wrap items-center gap-2">
                <NativeSelect
                  id="new-bot-check-in"
                  value={checkIn}
                  onChange={(event) => {
                    setCheckInTouched(true);
                    setCheckIn(event.target.value as CheckInSchedule | "off");
                  }}
                  data-id="new-bot-check-in-select"
                  className="w-32"
                >
                  {CHECK_IN_OPTIONS.map((option) => (
                    <NativeSelectOption key={option} value={option}>
                      {t(`bots.newDialog.checkIn.${option}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                {checkIn === "weekly" && (
                  <NativeSelect
                    id="new-bot-check-in-weekday"
                    value={String(checkInWeekday)}
                    onChange={(event) => {
                      setCheckInTouched(true);
                      setCheckInWeekday(Number(event.target.value) as Weekday);
                    }}
                    aria-label={t("bots.newDialog.checkInDayLabel")}
                    data-id="new-bot-check-in-weekday-select"
                    className="w-36"
                  >
                    {WEEKDAYS.map((weekday) => (
                      <NativeSelectOption key={weekday} value={String(weekday)}>
                        {weekdayName(weekday, i18n.language)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                )}
                {checkIn !== "off" && presetHasTime(checkIn) && (
                  <Input
                    id="new-bot-check-in-time"
                    type="time"
                    value={checkInTime}
                    onChange={(event) => {
                      setCheckInTouched(true);
                      setCheckInTime(event.target.value);
                    }}
                    aria-label={t("bots.newDialog.checkInTimeLabel")}
                    data-id="new-bot-check-in-time-input"
                    className="w-28"
                  />
                )}
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="new-bot-model">
                {t("bots.modelLabel")}
              </FieldLabel>
              <NativeSelect
                id="new-bot-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                data-id="new-bot-model-select"
              >
                <NativeSelectOption value="">
                  {t("bots.modelDefault")}
                </NativeSelectOption>
                {configuredModels.map((entry) => (
                  <NativeSelectOption key={entry.id} value={entry.id}>
                    {entry.label ?? entry.id}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <span className="text-muted-foreground text-xs">
                {t("bots.modelHelp")}
              </span>
            </Field>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </Dialog>
  );
};
