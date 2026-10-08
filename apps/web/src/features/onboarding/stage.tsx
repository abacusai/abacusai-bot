import type { BotRow } from "@abacus-ai/contract/contract";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { BootAvatar } from "#renderer/components/boot-avatar";
import { BotAvatar } from "#renderer/components/bot-avatar";
import {
  subscribeClock,
  subscribePointer,
} from "#renderer/components/bot-avatar/clock";
import type { ExpressionMix } from "#renderer/components/bot-avatar/expression";
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
  gaze: "cursor" | "centre";
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
  mood: AvatarMood,
  gaze: Keyframe["gaze"] = "cursor"
): Keyframe => ({ x, y, depth, mood, gaze });
export const CHOREOGRAPHY: Record<OnboardingStepId, readonly Keyframe[]> = {
  welcome: [
    frame(-42, 4, 1, "happy"),
    frame(-134, -12, 0.76, "wink"),
    frame(52, -6, 0.9, "love"),
    frame(139, -22, 0.64, "thinking"),
  ],
  connect: [
    frame(0, 0, 1, "waiting"),
    frame(-126, -30, 0.64, "thinking", "centre"),
    frame(115, -8, 0.72, "waiting", "centre"),
    frame(64, -64, 0.55, "idle", "centre"),
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
    frame(-119, -28, 0.65, "happy", "centre"),
    frame(-60, -68, 0.55, "wink", "centre"),
    frame(116, -20, 0.7, "love", "centre"),
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
interface Pointer {
  x: number;
  y: number;
  speed: number;
}
const REST: Pointer = { x: 0, y: 0, speed: 0 };
const useStagePointer = (
  reduced: boolean,
  root: React.RefObject<HTMLDivElement | null>
) => {
  const [pointer, setPointer] = useState(REST);
  useEffect(() => {
    if (reduced || !matchMedia("(hover: hover) and (pointer: fine)").matches)
      return;
    let latest = REST;
    let moved = 0;
    const stopPointer = subscribePointer((position) => {
      const bounds = root.current?.getBoundingClientRect();
      if (!bounds) return;
      latest = {
        x: position.x - bounds.x - bounds.width / 2,
        y: position.y - bounds.y - bounds.height / 2,
        speed: position.speed,
      };
      moved = position.at;
    });
    const stop = subscribeClock((_, visible) => {
      if (!visible) return;
      if (performance.now() - moved > 300 && latest.speed)
        latest = { ...latest, speed: 0 };
      setPointer(latest);
    });
    return () => {
      stop();
      stopPointer();
    };
  }, [reduced, root]);
  return pointer;
};

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
  const pointer = useStagePointer(reduced, root);
  const { slots, height } = stageFor(step, bot, phase);
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
        setReaction(event.type === "click" ? "excited" : "happy");
    };
    frame?.addEventListener("pointerover", react);
    frame?.addEventListener("click", react);
    return () => {
      frame?.removeEventListener("pointerover", react);
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
        const dx = pointer.x - slot.x;
        const dy = pointer.y - slot.y;
        const gaze = !reduced && slot.gaze === "cursor";
        const expression: ExpressionMix | undefined = gaze
          ? {
              from: "curious",
              to: "worried",
              mix: Math.min(1, pointer.speed / 2),
            }
          : undefined;
        const mood =
          reaction ??
          (!reduced && pointer.speed > 1 && Math.hypot(dx, dy) < 180
            ? "surprised"
            : slot.mood);
        const look =
          slot.id !== "first-bot" && index > 0 && cast[index - 1]
            ? botLook(cast[index - 1]!)
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
                    transform: `translate(${slot.x + (gaze ? Math.max(-4, Math.min(4, dx / 100)) : 0)}px, ${slot.y}px) scale(${slot.depth})`,
                    opacity: 1,
                  }
            }
            transition={reduced ? { duration: 0 } : springs.avatar}
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
                expression={expression}
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
