/**
 * A connect link's time left, split for words: days and hours from a day up,
 * hours and minutes from an hour up, else minutes (at least one). Shared by
 * the Connect card and what the model is told to pass on.
 */
export interface LinkTimeLeft {
  days: number;
  hours: number;
  minutes: number;
}

const DAY_MINUTES = 24 * 60;

export const linkTimeLeft = (ms: number): LinkTimeLeft => {
  const total = Math.max(1, Math.ceil(ms / 60_000));
  const days = Math.floor(total / DAY_MINUTES);
  const hours = Math.floor((total % DAY_MINUTES) / 60);
  return { days, hours, minutes: days > 0 ? 0 : total % 60 };
};

/** Whether the link still works after today ends, on the local calendar. */
export const linkOutlivesToday = (expiresAt: number, now: number): boolean =>
  new Date(expiresAt).toDateString() !== new Date(now).toDateString();
