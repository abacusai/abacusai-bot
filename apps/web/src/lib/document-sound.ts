import type { PrefsRow } from "@abacus-ai/contract/contract/rows";
import { useEffect } from "react";

import { cueClaim } from "#platform/attention";
import type { Transport } from "#renderer/data/transport";

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
    isWindowFocused: () => document.hasFocus() && !document.hidden,
    prefs: () => sounds,
    now: () => Date.now(),
    claim: (cueId, threadId) => claim(cueId, threadId),
  }));

/** The shell owns cross-window arbitration for the shared document player. */
export const useDocumentSoundOwner = (transport: Transport): void => {
  useEffect(() => {
    claim = cueClaim(transport);
    return () => {
      claim = async () => false;
    };
  }, [transport]);
};
