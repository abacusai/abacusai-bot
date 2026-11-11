/**
 * The wall, asked again when the user comes back. A free account's turn in
 * the user's own chat that stopped at the credit wall is stamped by main
 * (`dismissals.wallReopen`, credit-wall.ts). The next time the user is at the
 * app, it asks the credits dialog once more for that chat: its task, its
 * waiting message, and once paid that message on the plan's top model.
 *
 * "At the app" is the first input after the app opened (for a wall from
 * before it opened), or after it was away (hidden or in the background) for
 * half an hour: a wall met while the user is here was just asked live. A focused window is no
 * sign of the user: one the OS opened at login has focus with nobody there
 * (as "your work is waiting" holds). Once per wall: the ask is stamped before
 * it goes, so Not now stands, and only a new wall asks again. The dialog
 * host's fresh account read still decides; a paid or refilled account is
 * never asked.
 */
import type { UIMessage } from "@tanstack/ai-client";
import { useEffect, useEffectEvent, useState } from "react";

import { useCollections } from "#renderer/data/db";
import { isListedSession, isListedWorkspace } from "#renderer/data/db/filters";
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { IS_ELECTRON } from "#renderer/lib/platform";
import {
  handOffResume,
  lastUserText,
  requestUpgradeDialog,
  taskText,
} from "#renderer/lib/upgrade-dialog";

/** Away at least this long, and the next input is a return. */
export const WALL_REOPEN_AWAY_MS = 30 * 60_000;

export const WallReopenHost = ({
  messagesOf,
  openChat,
}: {
  /** The chat's messages, loaded off screen. */
  messagesOf(threadId: string): Promise<readonly UIMessage[]>;
  /** Opens the chat, whose view then sends the waiting message. */
  openChat(threadId: string): void;
}) => {
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  const collections = useCollections();
  const mark = prefs.dismissals.wallReopen ?? null;
  // A wall met before this launch is the user's return at the first input.
  const [openedAt] = useState(() => Date.now());
  const armedWall =
    IS_ELECTRON && mark != null && mark.askedAt == null ? mark.wallAt : null;

  const ask = useEffectEvent(async () => {
    if (mark == null || mark.askedAt != null) return;
    const row = collections.sessions.get(mark.sessionId);
    // Stamped first: whatever happens next, this wall is asked once.
    await update({
      dismissals: { wallReopen: { ...mark, askedAt: Date.now() } },
    }).catch(() => undefined);
    if (row == null) return;
    const workspace = collections.workspaces.get(row.workspaceId);
    const listed =
      isListedSession(row) && workspace != null && isListedWorkspace(workspace);
    const messages = await messagesOf(mark.sessionId).catch(() => []);
    const pendingText = lastUserText(messages);
    const task = listed ? taskText(messages) : undefined;
    requestUpgradeDialog(
      {
        kind: "credits",
        key: `wall-reopen:${mark.wallAt}`,
        threadId: mark.sessionId,
        reopen: true,
        ...(pendingText != null && { pendingText }),
        ...(task != null && { task }),
        resume: async (model?: string) => {
          handOffResume(mark.sessionId, model);
          openChat(mark.sessionId);
        },
      },
      true
    );
  });

  useEffect(() => {
    if (armedWall == null) return;
    let returning = armedWall < openedAt;
    let leftAt: number | null = null;
    const away = () => {
      leftAt ??= Date.now();
    };
    const back = () => {
      if (leftAt != null && Date.now() - leftAt >= WALL_REOPEN_AWAY_MS)
        returning = true;
      leftAt = null;
    };
    const visibility = () => (document.hidden ? away() : back());
    const input = () => {
      if (!returning) return;
      returning = false;
      void ask();
    };
    window.addEventListener("blur", away);
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", visibility);
    for (const type of ["pointerdown", "pointermove", "keydown"] as const)
      window.addEventListener(type, input, true);
    return () => {
      window.removeEventListener("blur", away);
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", visibility);
      for (const type of ["pointerdown", "pointermove", "keydown"] as const)
        window.removeEventListener(type, input, true);
    };
  }, [armedWall, openedAt]);

  return null;
};
