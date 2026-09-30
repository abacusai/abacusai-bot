import * as v from "valibot";

import {
  AVATAR_SHAPES,
  AVATAR_ACCESSORIES,
  isSupportedAvatarColor,
  resolveLook,
} from "#next/lib/bots/avatar";
import {
  CheckInDraftSchema,
  checkInFromRoutine,
} from "#next/lib/bots/check-in";
import {
  MAX_BOT_NAME,
  MAX_BOT_PERSONA,
  MAX_BOT_DESCRIPTION,
  MAX_BOT_TITLE,
} from "#shared/bots";
import type { BotRow, RoutineRow } from "#shared/contract/rows";
const trimmed = (max: number) =>
  v.pipe(v.string(), v.trim(), v.maxLength(max, "too-long"));
export const BotFormSchema = v.object({
  name: v.pipe(trimmed(MAX_BOT_NAME), v.minLength(1, "required")),
  persona: trimmed(MAX_BOT_PERSONA),
  instructions: trimmed(MAX_BOT_DESCRIPTION),
  description: trimmed(MAX_BOT_TITLE),
  look: v.object({
    shape: v.picklist(AVATAR_SHAPES),
    color: v.pipe(v.string(), v.check(isSupportedAvatarColor, "color")),
    accessory: v.picklist(AVATAR_ACCESSORIES),
  }),
  model: v.nullable(v.pipe(v.string(), v.minLength(1))),
  checkIn: CheckInDraftSchema,
});
export type BotFormValues = v.InferOutput<typeof BotFormSchema>;
export const valuesForBot = (
  bot: BotRow,
  routine: RoutineRow | null
): BotFormValues => ({
  name: bot.name,
  persona: bot.persona,
  instructions: bot.description,
  description: bot.title,
  look: resolveLook(bot),
  model: bot.model,
  checkIn: checkInFromRoutine(routine),
});
export const equalValue = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
export const editedPatch = (
  values: BotFormValues,
  baseline: BotFormValues
): Partial<BotRow> => {
  const patch: Partial<BotRow> = {};
  for (const [field, column] of [
    ["name", "name"],
    ["persona", "persona"],
    ["instructions", "description"],
    ["description", "title"],
    ["model", "model"],
  ] as const)
    if (!equalValue(values[field], baseline[field]))
      Object.assign(patch, { [column]: values[field] });
  for (const [field, column] of [
    ["shape", "avatarShape"],
    ["color", "avatarColor"],
    ["accessory", "avatarAccessory"],
  ] as const)
    if (values.look[field] !== baseline.look[field])
      Object.assign(patch, { [column]: values.look[field] });
  return patch;
};
