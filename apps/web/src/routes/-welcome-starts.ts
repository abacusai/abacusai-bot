import { continueInNewChat } from "#renderer/features/sessions/data/continue-chat";
import {
  newStartDraft,
  queueStartPrompt,
  startDraftStore,
} from "#renderer/features/sessions/start/start-session";
/**
 * The paid welcome's new chats on the plan's top model (paid-welcome.tsx):
 * the last chat continued from its summary (#787's continue-chat), or a first
 * task in a fresh draft, sent at once. Composed here because the welcome and
 * the session start page are separate features.
 */
import type { WelcomeStarts } from "#renderer/features/upgrade-dialog";
import { updateDraft } from "#renderer/lib/continuity/composer-drafts";

export const WELCOME_STARTS: WelcomeStarts = {
  continueChat: continueInNewChat,
  newTask: (model, prompt) => {
    const draft = newStartDraft();
    startDraftStore.setState(() => draft);
    updateDraft(`draft:${draft.id}`, (current) => ({
      ...current,
      model,
      text: "",
    }));
    queueStartPrompt(draft.id, prompt);
    return draft.id;
  },
};
