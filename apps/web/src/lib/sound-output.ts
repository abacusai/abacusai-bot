import type { AudioContextLike } from "./sound";

// One output per context for chat, onboarding and settings previews.
const outputs = new WeakMap<AudioContextLike, GainNode>();
export const masterOutput = (audio: AudioContextLike): GainNode => {
  const existing = outputs.get(audio);
  if (existing) return existing;
  const master = audio.createGain();
  master.gain.value = 1;
  const limiter = audio.createWaveShaper();
  const ceiling = Math.SQRT1_2;
  limiter.curve = Float32Array.from({ length: 4097 }, (_, i) => {
    const input = i / 2048 - 1;
    return ceiling * Math.tanh(input / ceiling);
  });
  master.connect(limiter);
  limiter.connect(audio.destination);
  outputs.set(audio, master);
  return master;
};
