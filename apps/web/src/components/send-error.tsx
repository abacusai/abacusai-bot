import { AlertCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { durations, easings, useMotionPreference } from "#renderer/lib/motion";
import { Alert, AlertDescription } from "#renderer/ui/alert";

export const SendError = ({ error }: { error: string | null }) => {
  const reduced = useMotionPreference() === "reduced";
  return (
    <div className="relative h-12 shrink-0" data-slot="send-error">
      <AnimatePresence initial={false}>
        {error && (
          <motion.div
            key={error}
            className="absolute inset-x-0 top-0"
            initial={{ opacity: reduced ? 1 : 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{
              duration: reduced ? 0 : durations.childFade / 1000,
              ease: easings.standard,
            }}
          >
            <Alert variant="destructive" aria-live="assertive" aria-atomic>
              <AlertCircle aria-hidden />
              <AlertDescription className="col-start-2 row-start-1 truncate">
                {error}
              </AlertDescription>
            </Alert>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
