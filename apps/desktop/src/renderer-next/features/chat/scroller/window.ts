/**
 * The bounded moving window of mounted rows (spec 02 §10), pure. At most
 * `MAX_ROWS` rows are mounted anywhere; activating a placeholder mounts the
 * next `STEP` rows on that side and evicts as many from the far side.
 * Returning to the end snaps back to the newest rows.
 */
export const MAX_ROWS = 400;
const STEP = 100;

export interface RowWindow {
  start: number;
  end: number;
}

export const newestWindow = (total: number, max = MAX_ROWS): RowWindow => ({
  start: Math.max(0, total - max),
  end: total,
});

export const showEarlier = (
  window: RowWindow,
  max = MAX_ROWS,
  step = STEP
): RowWindow => {
  const start = Math.max(0, window.start - step);
  return { start, end: Math.min(window.end, start + max) };
};

export const showLater = (
  window: RowWindow,
  total: number,
  max = MAX_ROWS,
  step = STEP
): RowWindow => {
  const end = Math.min(total, window.end + step);
  return { start: Math.max(window.start, end - max), end };
};

/**
 * Keeps a window valid as the list changes: pinned to the end it follows
 * new rows; elsewhere it keeps its rows (prepends shift both edges).
 */
export const followWindow = (
  window: RowWindow,
  previousTotal: number,
  total: number,
  prepended: number,
  max = MAX_ROWS
): RowWindow => {
  const atEnd = window.end >= previousTotal;
  // At the end, a page of history mounts above (up to the budget).
  if (atEnd) return { start: Math.max(0, total - max), end: total };
  const start = Math.min(total, window.start + prepended);
  const end = Math.min(total, window.end + prepended);
  return { start, end: Math.min(end, start + max) };
};

/** Local day key for separators; null without a time (§10). */
export const dayKey = (date: Date | null): string | null =>
  date == null
    ? null
    : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

export const messageTime = (message: {
  createdAt?: Date | string;
  metadata?: unknown;
}): Date | null => {
  if (message.createdAt != null) {
    const date = new Date(message.createdAt);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const iso = (
    message.metadata as { tanstack?: { createdAt?: string } } | undefined
  )?.tanstack?.createdAt;
  if (typeof iso === "string") {
    const date = new Date(iso);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
};
