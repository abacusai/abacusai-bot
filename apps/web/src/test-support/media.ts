/**
 * A controllable `matchMedia` for jsdom. `(min-width: Npx)` and
 * `(max-width: Npx)` evaluate against a simulated viewport width; any other
 * query (`prefers-color-scheme`, `prefers-reduced-motion`) is false unless set.
 * Changes notify the listeners of every live query list whose result flipped.
 */
interface Entry {
  list: MediaQueryList;
  listeners: Set<(event: MediaQueryListEvent) => void>;
  last: boolean;
}

const DEFAULT_WIDTH = 1280;

let width = DEFAULT_WIDTH;
let overrides: Record<string, boolean> = {};
const entries = new Set<Entry>();

const evaluate = (query: string): boolean => {
  const normalized = query.trim();
  if (normalized in overrides) return overrides[normalized] ?? false;
  const min = /^\(min-width:\s*(\d+(?:\.\d+)?)px\)$/.exec(normalized);
  if (min != null) return width >= Number(min[1]);
  const max = /^\(max-width:\s*(\d+(?:\.\d+)?)px\)$/.exec(normalized);
  if (max != null) return width <= Number(max[1]);
  return false;
};

const notify = (): void => {
  for (const entry of entries) {
    const next = evaluate(entry.list.media);
    if (next === entry.last) continue;
    entry.last = next;
    const event = {
      matches: next,
      media: entry.list.media,
    } as MediaQueryListEvent;
    for (const listener of entry.listeners) listener(event);
  }
};

/** Set the simulated viewport width (also `window.innerWidth`). */
export const setViewportWidth = (next: number): void => {
  width = next;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: next,
  });
  notify();
  window.dispatchEvent(new Event("resize"));
};

/** Force the result of specific queries, e.g. `(prefers-color-scheme: dark)`. */
export const setMediaMatches = (next: Record<string, boolean>): void => {
  overrides = { ...overrides, ...next };
  notify();
};

export const resetMedia = (): void => {
  width = DEFAULT_WIDTH;
  overrides = {};
  entries.clear();
};

const matchMedia = (query: string): MediaQueryList => {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const entry: Entry = {
    list: undefined as unknown as MediaQueryList,
    listeners,
    last: evaluate(query),
  };
  const list = {
    get matches() {
      return evaluate(query);
    },
    media: query,
    onchange: null,
    addListener: (listener: (event: MediaQueryListEvent) => void) =>
      listeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) =>
      listeners.delete(listener),
    addEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void
    ) => listeners.add(listener),
    removeEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void
    ) => listeners.delete(listener),
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
  entry.list = list;
  entries.add(entry);
  return list;
};

if (typeof window !== "undefined") {
  window.matchMedia = matchMedia;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: DEFAULT_WIDTH,
  });
}

/** A stub `navigator.windowControlsOverlay` with a settable rect. */
export const installWindowControlsOverlay = (rect: {
  x: number;
  y: number;
  width: number;
  height: number;
  visible?: boolean;
}): { setRect(next: typeof rect): void; uninstall(): void } => {
  const target = new EventTarget();
  let current = rect;
  const overlay = Object.assign(target, {
    get visible() {
      return current.visible ?? true;
    },
    getTitlebarAreaRect: () =>
      ({
        ...current,
        top: current.y,
        left: current.x,
        right: current.x + current.width,
        bottom: current.y + current.height,
      }) as DOMRect,
    ongeometrychange: null,
  });
  Object.defineProperty(navigator, "windowControlsOverlay", {
    configurable: true,
    value: overlay,
  });
  return {
    setRect(next) {
      current = next;
      const event = new Event("geometrychange");
      Object.assign(event, {
        titlebarAreaRect: overlay.getTitlebarAreaRect(),
        visible: overlay.visible,
      });
      target.dispatchEvent(event);
    },
    uninstall() {
      delete (navigator as { windowControlsOverlay?: unknown })
        .windowControlsOverlay;
    },
  };
};
