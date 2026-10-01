import { motion } from "motion/react";
import { useEffect, useState } from "react";

import { BotAvatar } from "#next/components/bot-avatar";
import type { Look } from "#next/lib/bots/avatar";
import { useMotionPreference } from "#next/lib/motion";

/** Canvas OnboardMotion: three 220 ms wobbles, then the damped pop. */
export const FirstBotHatch = ({ look }: { look: Look }) => {
  const reduced = useMotionPreference() === "reduced";
  const [egg, setEgg] = useState(true);
  const [pieces, setPieces] = useState(false);
  useEffect(() => {
    const crack = setTimeout(
      () => {
        setEgg(false);
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
      <motion.div
        className={egg ? "first-bot-egg" : undefined}
        key={egg ? "egg" : "hatched"}
        initial={{ scale: egg ? 1 : 0.9 }}
        animate={{ scale: 1 }}
        transition={
          reduced
            ? { duration: 0.12 }
            : { type: "spring", stiffness: 420, damping: 18, mass: 1 }
        }
      >
        <BotAvatar look={egg ? { ...look, shape: "egg" } : look} size={112} />
      </motion.div>
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
