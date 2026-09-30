/**
 * The floating sidebar's pointer timers, shared by the rail and the floating
 * sidebar of one shell (Claude impl r1 #15): per shell, never module-global.
 */
import { createContext, use, useEffect, useState } from "react";

import { createFloatingIntent, type FloatingIntent } from "./shell-store";

export const FloatingIntentContext = createContext<FloatingIntent | null>(null);

/**
 * The shell's timers, or a private set for a rail rendered on its own (the
 * gallery), cancelled when that rail unmounts.
 */
export const useFloatingIntent = (): FloatingIntent => {
  const shared = use(FloatingIntentContext);
  const [own] = useState(() => createFloatingIntent());
  useEffect(() => own.cancel, [own]);
  return shared ?? own;
};
