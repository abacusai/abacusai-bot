import { useCallback, useEffect, useRef, useState } from "react";

import type { UpdateStatus } from "#shared/update";

export type { UpdateStatus };

/**
 * The install action, shared by every surface that offers it. `clicked` gives
 * feedback in the beat before the service's `status.installing` lands;
 * `reset` returns a surface to clickable.
 */
export const useUpdateInstall = (
  status: UpdateStatus | null
): { installing: boolean; install: () => void; reset: () => void } => {
  const [clicked, setClicked] = useState(false);

  return {
    installing: clicked || status?.installing === true,
    install: useCallback(() => {
      setClicked(true);
      void window.api.update.install();
    }, []),
    reset: useCallback(() => setClicked(false), []),
  };
};

/**
 * The updater's status. The initial fetch is in flight while events already
 * arrive, so once a live event has landed the stale snapshot is dropped.
 */
export const useUpdateStatus = (): UpdateStatus | null => {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const live = useRef(false);

  useEffect(() => {
    let active = true;

    void window.api?.update?.getStatus?.().then((initial) => {
      if (active && !live.current) setStatus(initial);
    });

    const unsubscribe = window.api?.update?.onStatusChange?.((next) => {
      live.current = true;
      setStatus(next);
    });

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  return status;
};
