import type { EventEmitter } from "node:events";

/** Main window events that change the companion's calm policy. */
export const wireMainNotchEvents = (
  window: Pick<EventEmitter, "on">,
  changed: () => void
): void => {
  for (const event of ["focus", "blur", "show", "hide", "closed"])
    window.on(event, changed);
};
