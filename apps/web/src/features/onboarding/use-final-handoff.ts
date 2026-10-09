import { useEffect, useEffectEvent } from "react";

/** Leave the ready introduction after two seconds unless the user takes control. */
export const useFinalHandoff = (ready: boolean, complete: () => void) => {
  const finish = useEffectEvent(complete);
  useEffect(() => {
    if (!ready) return;
    const cancel = () => clearTimeout(timer);
    const timer = setTimeout(() => {
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      finish();
    }, 2000);
    document.addEventListener("pointerdown", cancel, true);
    document.addEventListener("keydown", cancel, true);
    return () => {
      cancel();
      document.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("keydown", cancel, true);
    };
  }, [ready]);
};
