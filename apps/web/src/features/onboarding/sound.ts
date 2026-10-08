import type { PrefsRow } from "@abacus-ai/contract/contract";
import { useEffect, useLayoutEffect, useState } from "react";

import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { useMotionPreference } from "#renderer/lib/motion";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { createSoundPlayer, type InteractionCue } from "#renderer/lib/sound";

export const onboardingSoundEnabled = (
  sounds: PrefsRow["sounds"],
  desktop: boolean
): boolean => sounds.perEvent.onboarding ?? desktop;
class SoundPreferences {
  value: { prefs: PrefsRow; enabled: boolean; reduced: boolean };
  constructor(value: SoundPreferences["value"]) {
    this.value = value;
  }
  update(value: SoundPreferences["value"]) {
    this.value = value;
  }
  enable(enabled: boolean) {
    this.value.enabled = enabled;
  }
  read() {
    return this.value;
  }
}

export const useOnboardingSound = () => {
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  const reduced = useMotionPreference() === "reduced";
  const [override, setOverride] = useState<boolean | null>(null);
  const enabled = override ?? onboardingSoundEnabled(prefs.sounds, IS_ELECTRON);
  const [current] = useState(
    () => new SoundPreferences({ prefs, enabled, reduced })
  );
  useLayoutEffect(() => {
    current.update({ prefs, enabled, reduced });
  }, [current, prefs, enabled, reduced]);
  const [player] = useState(() =>
    createSoundPlayer({
      isThreadVisible: () => false,
      isWindowFocused: () => document.hasFocus() && !document.hidden,
      prefs: () => ({
        ...current.read().prefs.sounds,
        enabled:
          current.read().prefs.sounds.enabled &&
          current.read().enabled &&
          !current.read().reduced,
      }),
      now: () => Date.now(),
    })
  );
  useEffect(() => {
    if (!enabled || reduced || !prefs.sounds.enabled) player.muteInteractions();
  }, [enabled, reduced, prefs.sounds.enabled, player]);
  useEffect(() => {
    const unlock = () => {
      if (current.read().enabled) player.unlock();
    };
    const pause = () => player.muteInteractions();
    document.addEventListener("pointerdown", unlock, { passive: true });
    document.addEventListener("keydown", unlock);
    document.addEventListener("visibilitychange", pause);
    window.addEventListener("blur", pause);
    return () => {
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
      document.removeEventListener("visibilitychange", pause);
      window.removeEventListener("blur", pause);
      player.dispose();
    };
  }, [player, current]);
  return {
    enabled,
    play: (cue: InteractionCue) => player.interaction(cue),
    toggle: () => {
      const next = !enabled;
      setOverride(next);
      current.enable(next);
      if (next) {
        player.unlock();
        player.interaction("pop");
      } else player.muteInteractions();
      void update({ sounds: { perEvent: { onboarding: next } } }).then(
        () => setOverride(null),
        () => setOverride(null)
      );
    },
  };
};
