import type { BotRow } from "@abacus-ai/contract/contract";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { BootAvatar } from "#renderer/components/boot-avatar";
import { BotAvatar } from "#renderer/components/bot-avatar";
import {
  AVATAR_PALETTE,
  resolveLook,
  type AvatarMood,
  type Look,
} from "#renderer/lib/bots/avatar";
import { springs } from "#renderer/lib/motion";
import type { OnboardingStepId } from "#renderer/lib/navigation/areas";

import { Confetti } from "./confetti";

export const PARADE = {
  "parade-blob": {
    look: { shape: "blob", color: AVATAR_PALETTE[0].hex, accessory: "none" },
    mood: "thinking",
  },
  "parade-bunny": {
    look: { shape: "bunny", color: "#f472b6", accessory: "bow" },
    mood: "happy",
  },
  "parade-cat": {
    look: { shape: "cat", color: "#fb923c", accessory: "none" },
    mood: "wink",
  },
  "first-bot": {
    look: { shape: "mochi", color: "#60a5fa", accessory: "glasses" },
    mood: "idle",
  },
} as const satisfies Record<string, { look: Look; mood: AvatarMood }>;
export type StageAvatarId = keyof typeof PARADE;
export type FirstBotPhase = "none" | "pending" | "ready";
interface Keyframe {
  x: number;
  y: number;
  depth: number;
  mood: AvatarMood;
}
export interface StageSlot extends Keyframe {
  id: StageAvatarId;
  look: Look;
  size: number;
}
export interface Stage {
  slots: StageSlot[];
  height: number;
}
const frame = (
  x: number,
  y: number,
  depth: number,
  mood: AvatarMood
): Keyframe => ({ x, y, depth, mood });
export const CHOREOGRAPHY: Record<OnboardingStepId, readonly Keyframe[]> = {
  welcome: [
    frame(-42, 4, 1, "happy"),
    frame(-134, -12, 0.76, "wink"),
    frame(52, -6, 0.9, "love"),
    frame(139, -22, 0.64, "thinking"),
  ],
  connect: [
    frame(0, 0, 1, "waiting"),
    frame(-126, -30, 0.64, "thinking"),
    frame(115, -8, 0.72, "waiting"),
    frame(64, -64, 0.55, "idle"),
  ],
  connected: [
    frame(0, -8, 1, "happy"),
    frame(-126, -8, 0.8, "excited"),
    frame(123, -12, 0.8, "happy"),
    frame(62, -64, 0.6, "wink"),
  ],
  models: [
    frame(-32, 0, 0.9, "focused"),
    frame(-126, -36, 0.62, "thinking"),
    frame(79, -8, 0.8, "thinking"),
    frame(130, -52, 0.55, "focused"),
  ],
  connectors: [
    frame(-22, -6, 0.9, "thinking"),
    frame(-128, -26, 0.7, "happy"),
    frame(100, -12, 0.8, "wink"),
    frame(48, -65, 0.6, "focused"),
  ],
  "first-bot": [
    frame(-119, -28, 0.65, "happy"),
    frame(-60, -68, 0.55, "wink"),
    frame(116, -20, 0.7, "love"),
    frame(0, 8, 1.15, "surprised"),
  ],
  done: [
    frame(-124, -20, 0.72, "excited"),
    frame(-55, -65, 0.65, "happy"),
    frame(125, -20, 0.72, "love"),
    frame(0, 8, 1, "excited"),
  ],
};
const IDS = Object.keys(PARADE) as StageAvatarId[];
export const botLook = (bot: BotRow): Look =>
  resolveLook({
    name: bot.name,
    avatarShape: bot.avatarShape,
    avatarColor: bot.avatarColor,
  });
export const stageFor = (
  step: OnboardingStepId,
  bot: BotRow | null,
  phase: FirstBotPhase
): Stage => ({
  height: 140,
  slots: IDS.map((id, index) => ({
    id,
    ...CHOREOGRAPHY[step][index]!,
    look:
      id === "first-bot" && bot
        ? botLook(bot)
        : id === "first-bot" && step === "first-bot" && phase === "pending"
          ? { ...PARADE[id].look, shape: "egg" }
          : PARADE[id].look,
    size: Math.round(88 * CHOREOGRAPHY[step][index]!.depth),
  })),
});
export const OnboardingStage = ({
  step,
  bot,
  phase,
  reduced,
  cast = [],
  onPoke,
}: {
  step: OnboardingStepId;
  bot: BotRow | null;
  phase: FirstBotPhase;
  reduced: boolean;
  cast?: readonly BotRow[];
  onPoke?: () => void;
}) => {
  const root = useRef<HTMLDivElement>(null);
  const { slots, height } = stageFor(step, bot, phase);
  const looks = cast.map(botLook);
  const [reaction, setReaction] = useState<"happy" | "excited" | null>(null);
  useEffect(() => {
    if (!reaction) return;
    const timer = setTimeout(() => setReaction(null), 600);
    return () => clearTimeout(timer);
  }, [reaction]);
  useEffect(() => {
    const frame = root.current?.closest(".onboarding-frame");
    const react = (event: Event) => {
      if (
        (event.target as Element).closest("[data-connector], [data-template]")
      )
        setReaction("excited");
    };
    frame?.addEventListener("click", react);
    return () => {
      frame?.removeEventListener("click", react);
    };
  }, []);
  return (
    <div
      ref={root}
      className="onboarding-stage"
      data-avatar-scene
      style={{ height }}
      data-reduced-motion={reduced}
    >
      {slots.map((slot, index) => {
        const mood = reaction ?? slot.mood;
        const look =
          slot.id !== "first-bot" && index > 0 && looks[index - 1]
            ? looks[index - 1]!
            : slot.look;
        return (
          <motion.div
            key={slot.id}
            className="onboarding-stage-avatar"
            data-avatar-id={slot.id}
            data-size={slot.size}
            initial={false}
            style={
              slot.id === "parade-blob"
                ? {
                    transform: `translate(${slot.x}px, ${slot.y}px) scale(${slot.depth})`,
                  }
                : undefined
            }
            animate={
              slot.id === "parade-blob"
                ? undefined
                : {
                    transform: `translate(${slot.x}px, ${slot.y}px) scale(${slot.depth})`,
                    opacity: 1,
                  }
            }
            transition={reduced ? { duration: 0 } : springs.surface}
            onPointerDown={() => {
              setReaction("excited");
              onPoke?.();
            }}
          >
            {slot.id === "parade-blob" ? (
              <BootAvatar
                mood={mood}
                look={look}
                size={88}
                brand={false}
                onPoke={onPoke}
                locationKey={step}
                reduce={reduced}
              />
            ) : (
              <BotAvatar
                look={look}
                mood={mood}
                followPointer={false}
                size={88}
                animate={!reduced}
              />
            )}
          </motion.div>
        );
      })}
      {step === "done" && <Confetti spread={360} reduced={reduced} />}
    </div>
  );
};
