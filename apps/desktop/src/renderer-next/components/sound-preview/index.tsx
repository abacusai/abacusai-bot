import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { createSoundPlayer, type Cue } from "#next/lib/sound";
import { Button } from "#next/ui/button";
export const SoundPreview = ({ cue }: { cue: Cue }) => {
  const { t } = useTranslation();
  const player = previewPlayer;
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={playing}
      aria-label={t("phase5.playSound", { cue: t(`phase5.cues.${cue}`) })}
      onClick={() => {
        player.preview(cue);
        setPlaying(true);
        timer.current = setTimeout(() => setPlaying(false), 600);
      }}
    >
      ▶
    </Button>
  );
};

const previewPlayer = createSoundPlayer({
  isThreadVisible: () => false,
  isWindowFocused: () => false,
  prefs: () => ({ enabled: true, perEvent: {} }),
  now: () => Date.now(),
});
