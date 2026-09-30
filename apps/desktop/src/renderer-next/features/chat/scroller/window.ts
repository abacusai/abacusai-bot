/**
 * The bounded moving window of mounted rows (spec 02 §10), pure.
 *
 * One row model over the transcript as it renders: every visible message is
 * one row, each of its mounted tool rows (and tool-group headers) is one
 * more, and each sub-agent card is one more. At most `MAX_ROWS` rows are
 * mounted anywhere. Placeholders ("Show earlier" / "Show later") stand for
 * the unmounted messages above and below; inside one message, tool rows past
 * the first `TOOL_PAGE` collapse into "{n} more steps", and rows evicted from
 * the top of a message become "{n} earlier steps". Activating a placeholder
 * mounts `STEP` more rows on that side and evicts as many from the far side
 * (possibly earlier rows of the same message). Returning to the end snaps
 * back to the newest rows with default tool ranges.
 */
export const MAX_ROWS = 100;
const STEP = 50;
const TOOL_PAGE = 50;
/** Placeholder height per row never measured (§10). */
export const ROW_FALLBACK_PX = 64;

/** One visible message, as far as the budget is concerned. */
export interface RowItem {
  id: string;
  /** Rows always mounted with the message (itself and anchored outcomes). */
  fixed: number;
  /** Pageable tool, group-header and sub-agent card units. */
  units: number;
}

export interface Range {
  start: number;
  end: number;
}

export interface WindowState {
  /** Visible-message indexes `[start, end)`. */
  start: number;
  end: number;
  /** Tool-unit ranges set by expansion or eviction; default `[0, TOOL_PAGE)`. */
  ranges: Readonly<Record<string, Range>>;
}

export const rangeOf = (
  item: RowItem,
  ranges: WindowState["ranges"]
): Range => {
  const set = ranges[item.id];
  if (set == null) return { start: 0, end: Math.min(item.units, TOOL_PAGE) };
  const start = Math.min(set.start, item.units);
  return { start, end: Math.max(start, Math.min(set.end, item.units)) };
};

const rowsOf = (item: RowItem, ranges: WindowState["ranges"]): number => {
  const range = rangeOf(item, ranges);
  return item.fixed + (range.end - range.start);
};

export const mountedRows = (
  items: readonly RowItem[],
  state: WindowState
): number => {
  let total = 0;
  for (let index = state.start; index < state.end; index += 1)
    total += rowsOf(items[index]!, state.ranges);
  return total;
};

const withRange = (
  ranges: WindowState["ranges"],
  id: string,
  range: Range
): WindowState["ranges"] => ({ ...ranges, [id]: range });

/**
 * Evicts from one side until the budget holds: whole messages first (never
 * `protect`), then the protected (or last remaining) message's own tool rows.
 */
const fit = (
  items: readonly RowItem[],
  state: WindowState,
  side: "top" | "bottom",
  protect: string | null = null
): WindowState => {
  let { start, end, ranges } = state;
  let total = mountedRows(items, state);
  const max = MAX_ROWS;
  while (total > max && end - start > 1) {
    const index = side === "top" ? start : end - 1;
    if (items[index]!.id === protect) break;
    total -= rowsOf(items[index]!, ranges);
    if (side === "top") start += 1;
    else end -= 1;
  }
  if (total > max) {
    const index =
      protect != null ? items.findIndex((i) => i.id === protect) : -1;
    const item =
      items[
        index >= start && index < end ? index : side === "top" ? start : end - 1
      ]!;
    const range = rangeOf(item, ranges);
    const excess = Math.min(total - max, range.end - range.start);
    ranges = withRange(
      ranges,
      item.id,
      side === "top"
        ? { start: range.start + excess, end: range.end }
        : { start: range.start, end: range.end - excess }
    );
  }
  return { start, end, ranges };
};

/** The newest rows: from the end upwards until the budget is spent. */
export const newestWindow = (
  items: readonly RowItem[],
  ranges: WindowState["ranges"] = {}
): WindowState => {
  const end = items.length;
  let start = end;
  let total = 0;
  while (start > 0) {
    const rows = rowsOf(items[start - 1]!, ranges);
    if (start < end && total + rows > MAX_ROWS) break;
    total += rows;
    start -= 1;
  }
  return fit(items, { start, end, ranges }, "top");
};

/** "Show earlier": at least `STEP` more rows above, evicting from below. */
export const showEarlier = (
  items: readonly RowItem[],
  state: WindowState
): WindowState => {
  let { start } = state;
  let added = 0;
  while (start > 0 && added < STEP) {
    start -= 1;
    added += rowsOf(items[start]!, state.ranges);
  }
  return fit(items, { ...state, start }, "bottom");
};

/** "Show later": at least `STEP` more rows below, evicting from above. */
export const showLater = (
  items: readonly RowItem[],
  state: WindowState
): WindowState => {
  let { end } = state;
  let added = 0;
  while (end < items.length && added < STEP) {
    added += rowsOf(items[end]!, state.ranges);
    end += 1;
  }
  return fit(items, { ...state, end }, "top");
};

/** "{n} more steps" in one message: `STEP` more below, evicting from above. */
export const moreSteps = (
  items: readonly RowItem[],
  state: WindowState,
  id: string
): WindowState => {
  const item = items.find((candidate) => candidate.id === id);
  if (item == null) return state;
  const range = rangeOf(item, state.ranges);
  const next = {
    ...state,
    ranges: withRange(state.ranges, id, {
      start: range.start,
      end: Math.min(item.units, range.end + STEP),
    }),
  };
  return fit(items, next, "top", id);
};

/** "{n} earlier steps" in one message: `STEP` more above, evicting from below. */
export const earlierSteps = (
  items: readonly RowItem[],
  state: WindowState,
  id: string
): WindowState => {
  const item = items.find((candidate) => candidate.id === id);
  if (item == null) return state;
  const range = rangeOf(item, state.ranges);
  const next = {
    ...state,
    ranges: withRange(state.ranges, id, {
      start: Math.max(0, range.start - STEP),
      end: range.end,
    }),
  };
  return fit(items, next, "bottom", id);
};

/**
 * Keeps the window valid as the list changes. At the end it follows new
 * rows (a page of history mounts above, up to the budget); elsewhere it
 * keeps its messages (a prepend shifts both edges).
 */
export const followWindow = (
  state: WindowState,
  previousTotal: number,
  items: readonly RowItem[],
  prepended: number,
  follow = state.end >= previousTotal
): WindowState => {
  if (follow) return newestWindow(items, state.ranges);
  const start = Math.min(items.length, state.start + prepended);
  const end =
    state.end >= previousTotal
      ? items.length
      : Math.min(items.length, state.end + prepended);
  return fit(items, { ...state, start, end }, "bottom");
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
