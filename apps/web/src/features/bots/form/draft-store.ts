import { useSelector } from "@tanstack/react-store";

import { defaultLook, resolveLook } from "#renderer/lib/bots/avatar";
import { DEFAULT_CHECK_IN } from "#renderer/lib/bots/check-in";
import { BOT_TEMPLATES } from "#renderer/lib/bots/templates";
import { persistedStore } from "#renderer/lib/continuity/registry";

import { newBotId } from "../data/bot-actions";
import type { BotFormValues } from "./schema";
export interface BotDraft {
  id: string;
  templateId: string | null;
  lookPicked?: boolean;
  values: BotFormValues;
  stages: { bot: boolean; checkIn: "none" | "persisted" | "failed" };
}
const draftStore = persistedStore<BotDraft | null>(
  "abacusai-bot:renderer:bot-draft",
  () => null
);
const write = (draft: BotDraft | null): void =>
  draftStore.setState(() => draft);
export const getDraft = (): BotDraft => {
  if (draftStore.state) return draftStore.state;
  const draft: BotDraft = {
    id: newBotId(),
    templateId: null,
    lookPicked: false,
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
    lookPicked: true,
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

interface EditDraft {
  values: BotFormValues;
  baseline: BotFormValues;
}
export const editDraftStore = persistedStore<Record<string, EditDraft>>(
  "abacusai-bot:abacus.bots.edits",
  () => ({})
);
export const clearEditDraft = (id: string) =>
  editDraftStore.setState((state) => {
    const { [id]: _removed, ...rest } = state;
    return rest;
  });

export const subscribeDraft = (
  listener: (draft: BotDraft | null) => void
): (() => void) => {
  const subscription = draftStore.subscribe((draft) => listener(draft));
  return () => subscription.unsubscribe();
};
