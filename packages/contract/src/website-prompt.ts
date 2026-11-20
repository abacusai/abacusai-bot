/**
 * The website's prompt: what someone typed in the prompt box on the bot's
 * website before signing up. The platform keeps it on the account and
 * /v1/account returns it (`website_prompt`) until the app says it was taken.
 * A fresh install runs it as the person's first task, labelled as theirs from
 * the website. It is still untrusted text: only ever shown, and sent as the
 * person's own message.
 */

/** Longer text is cut; the website's box takes no more. */
export const WEBSITE_PROMPT_MAX = 2000;

// Control characters but the newline and tab, and the bidi and zero-width
// marks that make text read differently from what it is.
const HIDDEN =
  // oxlint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** The prompt as the app may use it, or null when there is none. */
export const websitePromptText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const text = value.replace(HIDDEN, " ").trim();
  if (text.length === 0) return null;
  // By code point, so a cut never leaves half an emoji.
  return Array.from(text).slice(0, WEBSITE_PROMPT_MAX).join("").trimEnd();
};

/** Why a website prompt was not run: the install already has chats, or the person had typed their own words. */
export type WebsitePromptSkip = "has_sessions" | "typed";

/**
 * Whether this install runs the website prompt now. Only a fresh install
 * (no chats yet) whose box is still empty runs it; one that has already
 * taken a prompt never runs another.
 */
export const websitePromptDecision = (input: {
  prompt: unknown;
  taken: boolean;
  sessions: number;
  draft: string;
}):
  | { kind: "run"; prompt: string }
  | { kind: "skip"; reason: WebsitePromptSkip }
  | null => {
  const prompt = websitePromptText(input.prompt);
  if (prompt == null || input.taken) return null;
  if (input.sessions > 0) return { kind: "skip", reason: "has_sessions" };
  if (input.draft.trim().length > 0) return { kind: "skip", reason: "typed" };
  return { kind: "run", prompt };
};

/** A length bucket for the funnel: the text itself never leaves the machine that way. */
export const websitePromptSize = (
  prompt: string
): "short" | "medium" | "long" =>
  prompt.length > 200 ? "long" : prompt.length > 60 ? "medium" : "short";
