/**
 * Whether an OS notification plays the system sound (spec 05 §31.5 d, PLAN
 * §Sound). In the new-renderer generation (`wco`) every notification is
 * silent: the renderer's in-app cue is the sound. The legacy generation keeps
 * its rule, the user's notification-sound setting.
 */
export const notificationSilent = (
  generation: "legacy" | "wco",
  soundEnabled: boolean
): boolean => (generation === "wco" ? true : !soundEnabled);
