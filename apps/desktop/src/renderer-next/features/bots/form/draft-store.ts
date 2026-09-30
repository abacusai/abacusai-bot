import { Store, useSelector } from "@tanstack/react-store";

import { defaultLook, resolveLook } from "#next/lib/bots/avatar";
import { DEFAULT_CHECK_IN } from "#next/lib/bots/check-in";
import { BOT_TEMPLATES } from "#next/lib/bots/templates";

import { newBotId } from "../data/bot-actions";
import type { BotFormValues } from "./schema";
export interface BotDraft {
  id: string;
  templateId: string | null;
  values: BotFormValues;
  stages: { bot: boolean; checkIn: "none" | "persisted" | "failed" };
}
const storageKey = "renderer-next:bot-draft";
const restore = (): BotDraft | null => {
  try {
    return JSON.parse(
      sessionStorage.getItem(storageKey) ?? "null"
    ) as BotDraft | null;
  } catch {
    return null;
  }
};
const draftStore = new Store<BotDraft | null>(restore());
const write = (draft: BotDraft | null): void => {
  draftStore.setState(() => draft);
  try {
    if (draft) sessionStorage.setItem(storageKey, JSON.stringify(draft));
    else sessionStorage.removeItem(storageKey);
  } catch {
    /* A blocked storage still permits this document's draft. */
  }
};
export const getDraft = (): BotDraft => {
  if (draftStore.state) return draftStore.state;
  const draft: BotDraft = {
    id: newBotId(),
    templateId: null,
    stages: { bot: false, checkIn: "none" },
    values: {
      name: "",
      persona: "",
      instructions: "",
      description: "",
      look: defaultLook(""),
      model: null,
      checkIn: { ...DEFAULT_CHECK_IN },
    },
  };
  write(draft);
  return draft;
};
export const useBotDraft = (): BotDraft => {
  getDraft();
  return useSelector(draftStore, (state) => state!);
};
export const updateDraft = (patch: Partial<BotDraft>): void =>
  write({ ...getDraft(), ...patch });
export const clearDraft = (): void => write(null);
export const selectTemplate = (
  templateId: string,
  translatedName: string
): void => {
  const template = BOT_TEMPLATES.find((item) => item.id === templateId);
  if (!template) return;
  updateDraft({
    templateId,
    values: {
      ...getDraft().values,
      name: translatedName,
      persona: template.persona,
      instructions: template.mission,
      description: template.title,
      look: resolveLook({
        name: translatedName,
        avatarShape: template.avatarShape,
        avatarColor: template.avatarColor,
      }),
    },
  });
};
