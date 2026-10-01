import { useEffect, useState } from "react";

import { synthCue } from "#renderer/lib/sound";

/** Gallery-only native synthesis evidence; uses the production cue scheduler. */
export const SoundSynthesisProbe = () => {
  const [rms, setRms] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const audio = new OfflineAudioContext(1, 24000, 48000);
    synthCue(audio, "routine-fired");
    void audio.startRendering().then((buffer) => {
      const samples = buffer.getChannelData(0);
      const power =
        samples.reduce((sum, sample) => sum + sample * sample, 0) /
        samples.length;
      if (live) setRms(Math.sqrt(power));
    });
    return () => {
      live = false;
    };
  }, []);
  return <output data-sound-rms={rms ?? "pending"}>{rms}</output>;
};
