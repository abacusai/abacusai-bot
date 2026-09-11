import { type JSX } from "react";
import { useTranslation } from "react-i18next";

import { AbacusBotMascot } from "../brand/abacus-bot-mascot";

/**
 * What the agent shows while it is working: the mascot, and nothing else. The
 * status text goes on the wrapper as a live region, so a screen reader hears
 * "Reading file" while the screen shows the animation.
 */
export const ThinkingLoader = ({
  isVisible,
  label,
}: {
  isVisible: boolean;
  /** The CLI's spinner title ("Reading file"); announced rather than drawn. */
  label?: string | null;
}): JSX.Element | null => {
  const { t } = useTranslation();

  if (!isVisible) {
    return null;
  }

  return (
    <div
      className="flex items-center py-1 select-none"
      role="status"
      aria-live="polite"
      aria-label={
        label != null && label.length > 0
          ? label
          : t("workspace.thinking.inProgress")
      }
      data-id="thinking-indicator"
    >
      <AbacusBotMascot
        size={34}
        state="thinking"
        className="text-secondary-foreground"
        data-id="thinking-mascot"
      />
    </div>
  );
};
