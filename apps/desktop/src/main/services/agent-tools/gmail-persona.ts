/**
 * Who the user is, learned from their own sent mail the moment Gmail connects.
 * A hidden session reads the last few messages they wrote and files one
 * "Email persona" entry in the USER profile, so every later chat and bot
 * already knows how they talk, what they do and what they care about. Once
 * per profile: the entry's first line is the marker.
 */
import { readEntries } from "./memory-store";

export const GMAIL_CONNECTOR_ID = "abacus-gmailuser";
export const EMAIL_PERSONA_MARKER = "Email persona (from my sent mail):";
/** Enough to hear a voice, few enough to read in one sitting. */
export const SENT_MAIL_SAMPLE = 25;

export const hasEmailPersona = (): boolean => emailPersona() != null;

/** The persona as written, without its marker line, or null. */
export const emailPersona = (): string | null => {
  const entry = readEntries("user").find((item) =>
    item.startsWith(EMAIL_PERSONA_MARKER)
  );
  if (entry == null) return null;
  return entry.slice(EMAIL_PERSONA_MARKER.length).trim();
};

/** How long a hidden session gets to read the mail and file the entry. */
export const PERSONA_WAIT_MS = 15 * 60_000;
export const PERSONA_POLL_MS = 5_000;

/** The one-shot prompt the hidden session runs. */
export const emailPersonaPrompt = (): string =>
  [
    `Read the ${SENT_MAIL_SAMPLE} most recent emails I sent (Gmail search \`in:sent\`, newest first; open each message body; skip automated mail and newsletters).`,
    "From how I write and respond, work out who I am and write a short profile of me for your own use:",
    "- What I do: role, company or field, the projects and people that come up most.",
    "- How I respond: tone, typical length, formality, greetings and sign-offs, how direct I am, how quickly and how I say no.",
    "- What I care about and how I like things done.",
    'Then save it with the memory tool: target "user", action "add", one entry under 1500 characters whose first line is exactly:',
    EMAIL_PERSONA_MARKER,
    "Rules: describe patterns, never quote a message; no third-party email addresses or private details; do not draft, send, label or modify any mail.",
    "When it is saved, answer with one line saying what you learned about how I write. Nothing else.",
  ].join("\n");
