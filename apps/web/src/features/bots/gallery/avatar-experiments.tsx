/** Dev-only ablations. The six-avatar lease still applies to comparison pairs. */
import { useState } from "react";

import { BotAvatar } from "#renderer/components/bot-avatar";
import { AvatarExperimentContext } from "#renderer/components/bot-avatar/natural";
import {
  AVATAR_SHAPES,
  AVATAR_ACCESSORIES,
  type AvatarMood,
} from "#renderer/lib/bots/avatar";

const experiments = [
  "individuality",
  "gaze",
  "coupling",
  "speech",
  "phase",
  "shading",
] as const;
const moods: AvatarMood[] = [
  "idle",
  "talking",
  "thinking",
  "listening",
  "surprised",
  "happy",
  "sad",
  "error",
];
export const AvatarExperiments = () => {
  const [experiment, setExperiment] =
    useState<(typeof experiments)[number]>("individuality");
  const [mood, setMood] = useState<AvatarMood>("idle");
  const [board, setBoard] = useState(false);
  return (
    <div data-avatar-experiments className="space-y-6">
      <div className="flex flex-wrap gap-3">
        {experiments.map((flag) => (
          <button
            key={flag}
            aria-pressed={experiment === flag}
            onClick={() => setExperiment(flag)}
          >
            {flag}
          </button>
        ))}
        {moods.map((m) => (
          <button key={m} aria-pressed={mood === m} onClick={() => setMood(m)}>
            {m}
          </button>
        ))}
        <button aria-pressed={board} onClick={() => setBoard(!board)}>
          {"24 shapes × personalities" /* i18n-ignore: dev gallery */}
        </button>
      </div>
      {!board && (
        <div
          data-avatar-comparison
          className="grid grid-cols-2 gap-8 rounded-xl border p-6"
        >
          {[false, true].map((enabled) => (
            <AvatarExperimentContext
              key={String(enabled)}
              value={{ [experiment]: enabled }}
            >
              <div className="space-y-4">
                <p>
                  {
                    enabled
                      ? "Experiment on" /* i18n-ignore: dev gallery */
                      : "Experiment off" /* i18n-ignore: dev gallery */
                  }
                </p>
                <div className="flex gap-6">
                  {(["mochi", "pebble", "bunny"] as const).map((shape, i) => (
                    <BotAvatar
                      key={shape}
                      look={{
                        shape,
                        color: "#60a5fa",
                        accessory: i === 2 ? "cap" : "none",
                        identity: `study-${i}`,
                      }}
                      mood={mood}
                      size={120}
                      animate
                      interactive={false}
                    />
                  ))}
                </div>
              </div>
            </AvatarExperimentContext>
          ))}
        </div>
      )}
      {board && (
        <div
          data-avatar-personalities
          style={{
            display: "grid",
            gridTemplateColumns: "80px repeat(4, 90px)",
            gap: 8,
            width: "max-content",
          }}
        >
          <span />
          {[0, 1, 2, 3].map((i) => (
            <span key={i}>{`Identity ${i + 1}`}</span>
          ))}
          {AVATAR_SHAPES.map((shape) => (
            <div key={shape} style={{ display: "contents" }}>
              <span className="self-center">{shape}</span>
              {[0, 1, 2, 3].map((i) => (
                <BotAvatar
                  key={i}
                  look={{
                    shape,
                    color: "#60a5fa",
                    accessory: AVATAR_ACCESSORIES[i === 3 ? 4 : 0]!,
                    identity: `study-${i}`,
                  }}
                  mood={mood}
                  size={80}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
