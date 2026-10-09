import type { BotRow } from "@abacus-ai/contract/contract";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { BotAvatar } from "#renderer/components/bot-avatar";
import {
  defaultLook,
  resolveLook,
  type AvatarMood,
  type Look,
} from "#renderer/lib/bots/avatar";
import { springs } from "#renderer/lib/motion";
import type { OnboardingStepId } from "#renderer/lib/navigation/areas";

import { Confetti } from "./confetti";

export const PARADE = {
  "parade-blob": {
    look: defaultLook("AbacusAI Bot"),
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
  visible: boolean;
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
    frame(0, 0, 0.68, "idle"),
    frame(-126, -36, 0.62, "thinking"),
    frame(0, 0, 0.5, "idle"),
    frame(130, -52, 0.55, "focused"),
  ],
  connectors: [
    frame(0, 0, 0.68, "idle"),
    frame(-128, -26, 0.7, "happy"),
    frame(0, 0, 0.5, "idle"),
    frame(48, -65, 0.6, "focused"),
  ],
  "first-bot": [
    frame(-119, -28, 0.85, "happy"),
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
const CAST: Record<OnboardingStepId, readonly StageAvatarId[]> = {
  welcome: IDS,
  connect: ["parade-blob"],
  connected: ["parade-blob", "parade-bunny", "parade-cat"],
  models: ["parade-blob", "parade-cat"],
  connectors: ["parade-blob", "parade-cat"],
  "first-bot": ["parade-blob", "first-bot"],
  done: IDS,
};
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
  height: step === "models" || step === "connectors" ? 56 : 112,
  slots: IDS.map((id, index) => ({
    id,
    visible: CAST[step].includes(id),
    ...CHOREOGRAPHY[step][index]!,
    x: CHOREOGRAPHY[step][index]!.x * 0.85,
    y: CHOREOGRAPHY[step][index]!.y * 0.6,
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
  const flank = step === "models" || step === "connectors";
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
      style={{
        height: `var(${flank ? "--onboarding-dense-stage-height" : "--onboarding-stage-height"}, ${height}px)`,
      }}
      data-placement={flank ? "flank" : "above"}
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
            aria-hidden={!slot.visible}
            style={{ pointerEvents: slot.visible ? "auto" : "none" }}
            animate={{
              transform: slot.visible
                ? `translate(${slot.x}px, ${slot.y}px) scale(${slot.depth})`
                : "translate(0px, -40px) scale(0.25)",
              opacity: slot.visible ? 1 : 0,
            }}
            transition={reduced ? { duration: 0 } : springs.surface}
            onPointerDown={() => {
              setReaction("excited");
              onPoke?.();
            }}
          >
            <BotAvatar
              look={look}
              mood={mood}
              followPointer={false}
              size={88}
              animate={!reduced && slot.visible && !flank}
            />
          </motion.div>
        );
      })}
      {step === "done" && <Confetti spread={360} reduced={reduced} />}
    </div>
  );
};
