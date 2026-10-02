import { useEffect, useState } from "react";

import { BotAvatar } from "#renderer/components/bot-avatar";
import type { Look } from "#renderer/lib/bots/avatar";
import { useMotionPreference } from "#renderer/lib/motion";

/** Canvas OnboardMotion: three 220 ms wobbles, then the damped pop. */
export const FirstBotHatch = ({ look }: { look: Look }) => {
  const reduced = useMotionPreference() === "reduced";
  const [pieces, setPieces] = useState(false);
  useEffect(() => {
    const crack = setTimeout(
      () => {
        setPieces(!reduced);
      },
      reduced ? 120 : 660
    );
    const clear = setTimeout(() => setPieces(false), reduced ? 120 : 3860);
    return () => {
      clearTimeout(crack);
      clearTimeout(clear);
    };
  }, [reduced]);
  return (
    <div className="first-bot-hatch" aria-hidden="true">
      <div className="first-bot-glow" />
      <BotAvatar
        look={look}
        size={112}
        hatch={{ from: "egg", onDone: () => undefined }}
      />
      {pieces &&
        Array.from({ length: 7 }, (_, index) => (
          <i
            key={index}
            className="first-bot-confetti"
            style={{
              left: `${10 + index * 13}%`,
              animationDelay: `${(index * 0.8) / 6}s`,
              background: `var(--chart-${(index % 5) + 1})`,
            }}
          />
        ))}
    </div>
  );
};
