/**
 * The stage (canvas OnboardWelcome → OnboardDone, OnboardMotion): the bot
 * avatars are shared elements across the steps. Each one is a `motion.div`
 * with a stable `layoutId` inside one `LayoutGroup`, rendered by the frame
 * (the `/onboarding` layout), so React keeps the element mounted while the
 * step routes swap underneath and Motion morphs its position and size with
 * `springs.avatar`. Entering avatars rise in (12 px, staggered 60 ms),
 * leaving ones drift up and out (160 ms); the rest rearrange. The egg on
 * `first-bot` hatches into the created bot's own look, and that bot is the
 * one that stays on `done` and flies into the shell's bot identity
 * (`view-transition-name: bot-identity-<id>`, spec 06 OB17).
 *
 * `stageFor` is pure: which avatar ids, looks, moods and sizes a step shows.
 * Reduced motion: every change is a cut, nothing bobs.
 */
import type { BotRow } from "@abacus-ai/contract/contract";
import { Check } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useState, type CSSProperties } from "react";

import { BotAvatar } from "#renderer/components/bot-avatar";
import {
  AVATAR_PALETTE,
  resolveLook,
  type AvatarMood,
  type Look,
} from "#renderer/lib/bots/avatar";
import {
  easings,
  onboarding as onboardingMotion,
  reducedTransition,
  springs,
} from "#renderer/lib/motion";
import type { OnboardingStepId } from "#renderer/lib/navigation/areas";
import { useSharedElementName } from "#renderer/lib/navigation/shared-element";
import { IS_ELECTRON } from "#renderer/lib/platform";

import { Confetti } from "./confetti";

export type StageAvatarId =
  | "parade-bunny"
  | "parade-blob"
  | "parade-mochi"
  | "parade-cat"
  | "parade-star"
  | "first-bot";

export interface StageSlot {
  id: StageAvatarId;
  look: Look;
  mood: AvatarMood;
  size: number;
  /** The connected check (canvas OnboardConnected). */
  badge?: boolean;
  /** The 220 px pulse behind the egg (canvas OnboardFirstBot). */
  glow?: boolean;
  /** Play the egg → look hatch (the bot exists now). */
  hatch?: boolean;
  /** A cross-route shared-element name (the flight into the shell). */
  shared?: string;
}

export interface Stage {
  slots: StageSlot[];
  /** The stage's reserved height, so the step below does not jump. */
  height: number;
}

const swatch = (id: (typeof AVATAR_PALETTE)[number]["id"]): string =>
  AVATAR_PALETTE.find((entry) => entry.id === id)!.hex;

const look = (
  shape: Look["shape"],
  color: (typeof AVATAR_PALETTE)[number]["id"],
  accessory: Look["accessory"] = "none"
): Look => ({ shape, color: swatch(color), accessory });

/** Canvas OnboardWelcome's five, left to right. */
export const PARADE = {
  "parade-bunny": { look: look("bunny", "pink", "bow"), mood: "happy" },
  "parade-blob": { look: look("blob", "green"), mood: "wink" },
  "parade-mochi": { look: look("mochi", "blue", "glasses"), mood: "idle" },
  "parade-cat": { look: look("cat", "orange"), mood: "love" },
  "parade-star": { look: look("star", "yellow", "crown"), mood: "excited" },
} as const satisfies Record<
  Exclude<StageAvatarId, "first-bot">,
  { look: Look; mood: AvatarMood }
>;

const parade = (
  id: Exclude<StageAvatarId, "first-bot">,
  size: number,
  mood: AvatarMood = PARADE[id].mood
): StageSlot => ({ id, look: PARADE[id].look, mood, size });

/** The egg's colour before the bot exists (the Chief of Staff template's green). */
const PENDING_EGG: Look = {
  shape: "egg",
  color: swatch("green"),
  accessory: "none",
};

export type FirstBotPhase = "none" | "pending" | "ready";

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
): Stage => {
  switch (step) {
    case "welcome":
      // The browser's welcome is the account hand-off (first-run.ts): the
      // waiting blob, as on `connect`, never the parade.
      if (!IS_ELECTRON)
        return { height: 96, slots: [parade("parade-blob", 88, "waiting")] };
      return {
        height: 120,
        slots: [
          parade("parade-bunny", 56),
          parade("parade-blob", 72),
          parade("parade-mochi", 88),
          parade("parade-cat", 72),
          parade("parade-star", 56),
        ],
      };
    case "connect":
      return { height: 96, slots: [parade("parade-blob", 88, "waiting")] };
    case "connected":
      return {
        height: 104,
        slots: [{ ...parade("parade-blob", 96, "happy"), badge: true }],
      };
    case "models":
    case "connectors":
      return { height: 0, slots: [] };
    case "first-bot":
      if (phase === "none") return { height: 0, slots: [] };
      return {
        height: 140,
        slots: [
          bot && phase === "ready"
            ? {
                id: "first-bot",
                look: botLook(bot),
                mood: "surprised",
                size: 112,
                glow: true,
                hatch: true,
              }
            : {
                id: "first-bot",
                look: PENDING_EGG,
                mood: "surprised",
                size: 112,
                glow: true,
              },
        ],
      };
    case "done":
      return {
        height: 120,
        slots: [
          parade("parade-bunny", 56),
          bot
            ? {
                id: "first-bot",
                look: botLook(bot),
                mood: "excited",
                size: 80,
                shared: `bot-identity-${bot.id}`,
              }
            : parade("parade-blob", 80, "excited"),
          parade("parade-cat", 56),
        ],
      };
  }
};

const rise = (index: number, reduced: boolean) =>
  reduced
    ? { ...reducedTransition, layout: { duration: 0 } }
    : {
        layout: springs.avatar,
        opacity: {
          duration: onboardingMotion.stepEnter / 1000,
          ease: easings.standard,
          delay: (index * onboardingMotion.stagger) / 1000,
        },
        y: {
          duration: onboardingMotion.stepEnter / 1000,
          ease: easings.standard,
          delay: (index * onboardingMotion.stagger) / 1000,
        },
      };

const leave = (reduced: boolean) =>
  reduced
    ? reducedTransition
    : { duration: onboardingMotion.stepExit / 1000, ease: easings.standard };

const StageAvatar = ({
  slot,
  index,
  reduced,
  onHatched,
}: {
  slot: StageSlot;
  index: number;
  reduced: boolean;
  onHatched(): void;
}) => {
  const shared = useSharedElementName(slot.shared ?? null);
  return (
    <motion.div
      className="onboarding-stage-avatar"
      data-avatar-id={slot.id}
      data-size={slot.size}
      layout
      layoutId={slot.id}
      initial={{ opacity: 0, y: reduced ? 0 : onboardingMotion.rise }}
      animate={{ opacity: 1, y: 0 }}
      exit={{
        opacity: 0,
        y: reduced ? 0 : -onboardingMotion.rise,
        transition: leave(reduced),
      }}
      transition={rise(index, reduced)}
      style={shared}
    >
      {slot.glow && (
        <span
          className="onboarding-glow"
          aria-hidden="true"
          style={{ "--ob-glow": slot.look.color } as CSSProperties}
        />
      )}
      <span
        className="onboarding-bob"
        style={{ animationDelay: `${(index * 4) / 10}s` }}
      >
        <BotAvatar
          look={slot.look}
          mood={slot.mood}
          size={slot.size}
          animate={!reduced}
          hatch={slot.hatch ? { from: "egg", onDone: onHatched } : undefined}
        />
      </span>
      <AnimatePresence>
        {slot.badge && (
          <motion.span
            className="onboarding-badge"
            aria-hidden="true"
            initial={{ opacity: 0, scale: reduced ? 1 : 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, transition: leave(reduced) }}
            transition={
              reduced
                ? reducedTransition
                : { ...springs.badge, delay: onboardingMotion.stagger / 1000 }
            }
          >
            <Check size={14} strokeWidth={3} />
          </motion.span>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export const OnboardingStage = ({
  step,
  bot,
  phase,
  reduced,
}: {
  step: OnboardingStepId;
  bot: BotRow | null;
  phase: FirstBotPhase;
  reduced: boolean;
}) => {
  const { slots, height } = stageFor(step, bot, phase);
  const [hatched, setHatched] = useState<string | null>(null);
  // One burst per slide: when the hatch lands on first-bot, on arriving at done.
  const burst =
    step === "done" ||
    (step === "first-bot" && bot != null && hatched === bot.id);
  return (
    <LayoutGroup id="onboarding-stage">
      <div
        className="onboarding-stage"
        data-empty={slots.length === 0 ? "" : undefined}
        aria-hidden="true"
        style={{ "--stage-h": `${height}px` } as CSSProperties}
      >
        <AnimatePresence>
          {slots.map((slot, index) => (
            <StageAvatar
              key={slot.id}
              slot={slot}
              index={index}
              reduced={reduced}
              onHatched={() => setHatched(bot?.id ?? null)}
            />
          ))}
        </AnimatePresence>
        {burst && (
          <Confetti
            key={step}
            spread={step === "done" ? 360 : 140}
            reduced={reduced}
          />
        )}
      </div>
    </LayoutGroup>
  );
};
