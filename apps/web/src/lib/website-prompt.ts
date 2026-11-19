/**
 * This install's record of the website's prompt (contract website-prompt.ts):
 * once it is run or passed over it is never run again here, whatever the
 * account still says while the platform catches up. When it was run, the
 * chat it started, which carries the "from the website" label.
 */
const KEY = "abacusai-bot:onboarding.websitePrompt";

interface Taken {
  /** The chat it was sent in; null when it was passed over. */
  sessionId: string | null;
  at: number;
}

const read = (): Taken | null => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return null;
    const value = JSON.parse(raw) as Partial<Taken> | null;
    return {
      sessionId: typeof value?.sessionId === "string" ? value.sessionId : null,
      at: typeof value?.at === "number" ? value.at : 0,
    };
  } catch {
    // Unreadable storage counts as taken: never risk running it twice.
    return { sessionId: null, at: 0 };
  }
};

/** Whether this install has already run or passed over a website prompt. */
export const websitePromptTaken = (): boolean => read() != null;

/** The chat the website's prompt was sent in, if this install sent one. */
export const websitePromptSessionId = (): string | null =>
  read()?.sessionId ?? null;

/** Records the prompt as taken: sent in `sessionId`, or passed over (null). */
export const noteWebsitePromptTaken = (sessionId: string | null): void => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ sessionId, at: Date.now() }));
  } catch {
    // Storage off: the platform's ack still keeps it from coming back.
  }
};
