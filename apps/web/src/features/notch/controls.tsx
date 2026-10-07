import { motion } from "motion/react";
import { createContext, use, type ComponentProps } from "react";

import { durations, notch } from "#renderer/lib/motion";
import { Button } from "#renderer/ui/button";

const MotionButton = motion.create(Button);

export const NotchReducedMotion = createContext(true);

/** Position projection keeps icons and text at their natural size. */
export const notchMotion = (reduced: boolean) => {
  return {
    layout: reduced ? false : ("position" as const),
    transition: {
      layout: reduced ? { duration: 0 } : notch.surfaceSpring,
      opacity: { duration: reduced ? 0 : durations.childFade / 1000 },
    },
  };
};

export const useNotchMotion = () => notchMotion(use(NotchReducedMotion));

/** Existing button semantics and translations, with compact icon presentation. */
export const NotchAction = ({
  label,
  ...props
}: ComponentProps<typeof MotionButton> & { label: string }) => {
  const animation = useNotchMotion();
  return (
    <MotionButton
      {...animation}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      data-notch-action
      data-secondary={props.variant === "ghost" || undefined}
      size="icon"
      aria-label={label}
      title={label}
      {...props}
    />
  );
};
