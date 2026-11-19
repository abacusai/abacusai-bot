import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { websitePromptDecision } from "@abacus-ai/contract/website-prompt";

/**
 * The website's prompt as onboarding's first task (contract
 * website-prompt.ts): whether this install runs it, and the fresh chat it is
 * sent in. Composed here because onboarding and the session start page are
 * separate features, like the paid welcome's first task (-welcome-starts.ts).
 */
import {
  newStartDraft,
  queueStartPrompt,
  startDraftStore,
} from "#renderer/features/sessions/start/start-session";
import {
  draftStore,
  updateDraft,
} from "#renderer/lib/continuity/composer-drafts";
import { IS_ELECTRON } from "#renderer/lib/platform";
import {
  noteWebsitePromptTaken,
  websitePromptTaken,
} from "#renderer/lib/website-prompt";

export type WebsitePromptPlan = ReturnType<typeof websitePromptDecision>;

/**
 * Desktop only, and only for a fresh install: no chats yet and nothing typed
 * in the start box. The account's prompt is the person's own words from the
 * website, so it runs instead of the first-run screen's picks.
 */
export const planWebsitePrompt = (
  account: Pick<AbacusAccountInfo, "website_prompt"> | null | undefined,
  sessions: number
): WebsitePromptPlan =>
  IS_ELECTRON
    ? websitePromptDecision({
        prompt: account?.website_prompt,
        taken: websitePromptTaken(),
        sessions,
        draft:
          draftStore.state[`draft:${startDraftStore.state.id}`]?.text ?? "",
      })
    : null;

/**
 * A fresh draft with the prompt queued: the start page sends it as soon as
 * its box is ready, as the person's own first message, on the house like any
 * first-run pick. Returns the draft id, which becomes the chat's id.
 */
export const startWebsitePrompt = (prompt: string): string => {
  const draft = { ...newStartDraft(), sponsored: true as const };
  startDraftStore.setState(() => draft);
  updateDraft(`draft:${draft.id}`, (current) => ({ ...current, text: "" }));
  queueStartPrompt(draft.id, prompt);
  noteWebsitePromptTaken(draft.id);
  return draft.id;
};

/** The install had chats, or the person had typed first: theirs wins, and the prompt is let go. */
export const passOverWebsitePrompt = (): void => noteWebsitePromptTaken(null);
