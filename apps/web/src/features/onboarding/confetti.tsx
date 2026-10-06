/**
 * Confetti (canvas OnboardFirstBot, OnboardDone; spec 06 §8.2): seven
 * 8 × 12 pieces in the avatar palette falling 160 px while turning 320°,
 * one 2.4 s run staggered over 0–1.2 s, then the element is gone. CSS only
 * (no library, no canvas): the keyframes live in onboarding.css and run
 * off the main thread. Nothing under reduced motion.
 */
import { useEffect, useState, type CSSProperties } from "react";

import { AVATAR_PALETTE } from "#renderer/lib/bots/avatar";
import { hatch } from "#renderer/lib/motion";

/** The canvas's stagger, in seconds, piece by piece. */
const DELAYS = [0, 0.5, 0.9, 0.3, 0.7, 1.1, 0.2] as const;
const COLOURS = [
  "purple",
  "green",
  "blue",
  "yellow",
  "pink",
  "orange",
  "teal",
] as const;

export const CONFETTI_RUN_MS = hatch.confettiMs + Math.max(...DELAYS) * 1000;

export const Confetti = ({
  spread = 320,
  reduced,
}: {
  /** The horizontal span the pieces cover, centred on the stage, in px. */
  spread?: number;
  reduced: boolean;
}) => {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (reduced) return;
    const timer = setTimeout(() => setDone(true), CONFETTI_RUN_MS);
    return () => clearTimeout(timer);
  }, [reduced]);
  if (reduced || done) return null;
  const step = spread / (hatch.confettiPieces - 1);
  return (
    <span
      className="onboarding-confetti"
      aria-hidden="true"
      data-slot="confetti"
    >
      {Array.from({ length: hatch.confettiPieces }, (_, index) => (
        <i
          key={index}
          style={
            {
              left: `calc(50% + ${Math.round(index * step - spread / 2)}px)`,
              animationDelay: `${DELAYS[index % DELAYS.length]}s`,
              background: AVATAR_PALETTE.find(
                (entry) => entry.id === COLOURS[index % COLOURS.length]
              )!.hex,
            } as CSSProperties
          }
        />
      ))}
    </span>
  );
};
