/**
 * `abacusaibot://open?session=<id>&draft=<text>&src=<code>`: a link (an email,
 * a web page) that brings the app up at one chat, or with no `session` at a
 * new chat with the draft in its box. Any page can fire it, so every
 * parameter is untrusted text: nothing is run, sent or approved from it.
 */

export const OPEN_LINK_SCHEME = "abacusaibot";

/** The `src` of the link the upgrade page fires once a plan is paid for: the app is to read its account again, where it is. */
export const OPEN_LINK_UPGRADE_SRC = "upgrade";

/** A draft longer than this is cut; it is a starting point, not a message. */
export const OPEN_LINK_DRAFT_MAX = 500;

const OPEN_LINK_RAW_MAX = 4096;
const OPEN_LINK_SRC_MAX = 40;
const OPEN_LINK_SESSION_MAX = 128;

export interface OpenLink {
  /** A well-formed id; whether that chat exists here is the renderer's call. */
  sessionId: string | null;
  /** Text for that chat's composer (a new chat's without one), never sent by the app. */
  draft: string | null;
  /** The campaign code, `[a-z0-9_]{0,40}`. */
  src: string;
}

// The thread store's id rule (contract ids.ts SessionId), with a length cap.
const SESSION_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

// Control characters, and the bidi and zero-width marks that make text read
// differently from what it is.
const HIDDEN =
  // oxlint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

export const openLinkSessionId = (value: string | null): string | null =>
  value != null &&
  value.length <= OPEN_LINK_SESSION_MAX &&
  SESSION_ID.test(value)
    ? value
    : null;

export const openLinkDraft = (value: string | null): string | null => {
  if (value == null) return null;
  const text = value.replace(HIDDEN, " ").replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  // By code point, so a cut never leaves half an emoji.
  return Array.from(text).slice(0, OPEN_LINK_DRAFT_MAX).join("").trimEnd();
};

export const openLinkSrc = (value: string | null): string =>
  (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, OPEN_LINK_SRC_MAX);

/** The link `raw` asks for, or null when it is not one of ours. */
export const parseOpenLink = (raw: unknown): OpenLink | null => {
  if (typeof raw !== "string" || raw.length > OPEN_LINK_RAW_MAX) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // Windows hands some links over as `abacusaibot://open/?…`.
  if (
    url.protocol !== `${OPEN_LINK_SCHEME}:` ||
    url.hostname.toLowerCase() !== "open" ||
    (url.pathname !== "" && url.pathname !== "/")
  )
    return null;
  const session = url.searchParams.get("session");
  const sessionId = openLinkSessionId(session);
  return {
    sessionId,
    // A draft written for a chat goes with that chat when its id fails; one
    // sent without a chat is for a new one.
    draft:
      session != null && sessionId == null
        ? null
        : openLinkDraft(url.searchParams.get("draft")),
    src: openLinkSrc(url.searchParams.get("src")),
  };
};

/** The first argument that is one of our links (Windows and Linux pass it in argv). */
export const openLinkInArgv = (argv: readonly string[]): string | null =>
  argv.find((arg) => arg.toLowerCase().startsWith(`${OPEN_LINK_SCHEME}:`)) ??
  null;
