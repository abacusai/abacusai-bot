import { Check, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";

import { NotchAction, useNotchMotion } from "./controls";
export const ListeningControls = ({
  state,
  level,
  end,
  cancel,
}: {
  state: string;
  level: number;
  end(): void;
  cancel(): void;
}) => {
  const { t } = useTranslation();
  const animation = useNotchMotion();
  return (
    <motion.div {...animation} className="notch-listening">
      <h2 role="status" className="sr-only">
        {t(
          state === "transcribing"
            ? "notch.listening.transcribing"
            : "notch.listening.title"
        )}
      </h2>
      <div className="notch-wave" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((n) => (
          <span key={n} style={{ height: 8 + level * (16 + n * 3) }} />
        ))}
      </div>
      <div className="flex gap-2">
        <NotchAction
          label={t("notch.listening.end")}
          disabled={state !== "recording"}
          onClick={end}
          data-primary
        >
          <Check aria-hidden />
        </NotchAction>
        <NotchAction
          label={t("common.cancel")}
          variant="ghost"
          onClick={cancel}
        >
          <X aria-hidden />
        </NotchAction>
      </div>
      <AnimatePresence initial={false}>
        {state === "error" && (
          <motion.p
            {...animation}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            role="alert"
          >
            {t("notch.listening.error")}
          </motion.p>
        )}
      </AnimatePresence>
    </motion.div>
  );
};
