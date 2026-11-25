import { AlertCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { durations, easings, useMotionPreference } from "#renderer/lib/motion";
import { Alert, AlertDescription } from "#renderer/ui/alert";

export const SendError = ({
  error,
  reserve = true,
}: {
  error: string | null;
  /** Hold the row's height while empty so a form below does not jump. */
  reserve?: boolean;
}) => {
  const reduced = useMotionPreference() === "reduced";
  if (!reserve && !error) return null;
  return (
    <div
      className={reserve ? "relative h-12 w-full shrink-0" : "w-full shrink-0"}
      data-slot="send-error"
    >
      <AnimatePresence initial={false}>
        {error && (
          <motion.div
            key={error}
            className={reserve ? "absolute inset-x-0 top-0" : undefined}
            initial={{ opacity: reduced ? 1 : 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{
              duration: reduced ? 0 : durations.childFade / 1000,
              ease: easings.standard,
            }}
          >
            <Alert className="text-failed" aria-live="assertive" aria-atomic>
              <AlertCircle aria-hidden />
              <AlertDescription className="text-failed col-start-2 row-start-1 truncate">
                {error}
              </AlertDescription>
            </Alert>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
