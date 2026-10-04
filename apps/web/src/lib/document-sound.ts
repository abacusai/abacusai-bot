import type { PrefsRow } from "@abacus-ai/contract/contract/rows";
import { useEffect } from "react";

import type { Transport } from "#renderer/data/transport";
import { IS_ELECTRON } from "#renderer/lib/platform";

import { isThreadSeen } from "./navigation/visible-thread";
import { createSoundPlayer } from "./sound";
let sounds: PrefsRow["sounds"] = { enabled: true, perEvent: {} };
let claim: (
  cueId: string,
  threadId: string | null
) => Promise<boolean> = async () => false;
let player: ReturnType<typeof createSoundPlayer> | null = null;
export const setDocumentSoundPrefs = (prefs: PrefsRow["sounds"]) => {
  sounds = prefs;
};
export const documentSoundPlayer = () =>
  (player ??= createSoundPlayer({
    isThreadVisible: (id) => isThreadSeen(id, () => true),
    isWindowFocused: () => document.hasFocus(),
    prefs: () => sounds,
    now: () => Date.now(),
    claim: (cueId, threadId) => claim(cueId, threadId),
  }));

/** The shell owns cross-window arbitration for the shared document player. */
export const useDocumentSoundOwner = (transport: Transport): void => {
  useEffect(() => {
    claim = !IS_ELECTRON
      ? async () => true
      : (cueId, threadId) =>
          transport.client.window
            .claimCue({ cueId, threadId })
            .then((result) => result.play);
    return () => {
      claim = async () => false;
    };
  }, [transport]);
};
