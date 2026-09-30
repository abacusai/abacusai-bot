import type { PrefsRow } from "#shared/contract/rows";

import { isThreadSeen } from "./navigation/visible-thread";
import { createSoundPlayer } from "./sound";
let sounds: PrefsRow["sounds"] = { enabled: true, perEvent: {} };
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
  }));
