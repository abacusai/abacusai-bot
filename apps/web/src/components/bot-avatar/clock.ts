/** One low-frequency clock and one observer for the whole avatar population.
 * Motion owns spring frames. No clock subscribers for tiny/offscreen avatars. */
type Listener = (seconds: number, visible: boolean) => void;
let focused = true;
const listeners = new Set<Listener>();
const activityListeners = new Set<(visible: boolean) => void>();
let observingActivity = false;
let timer: ReturnType<typeof setInterval> | undefined;
const tick = () => {
  const visible = !document.hidden && focused;
  for (const listener of listeners) listener(performance.now() / 1000, visible);
};
const visibility = () => {
  if (document.hidden || !focused) {
    clearInterval(timer);
    timer = undefined;
  } else if (!timer && listeners.size) timer = setInterval(tick, 100);
  for (const listener of activityListeners)
    listener(!document.hidden && focused);
  tick();
};
const focus = () => {
  focused = true;
  visibility();
};
const blur = () => {
  focused = false;
  visibility();
};
const watchActivity = () => {
  if (observingActivity) return;
  observingActivity = true;
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("focus", focus);
  window.addEventListener("blur", blur);
};
const stopWatching = () => {
  if (listeners.size || activityListeners.size) return;
  document.removeEventListener("visibilitychange", visibility);
  window.removeEventListener("focus", focus);
  window.removeEventListener("blur", blur);
  observingActivity = false;
  focused = true;
};
export const subscribeActivity = (
  listener: (visible: boolean) => void
): (() => void) => {
  activityListeners.add(listener);
  watchActivity();
  listener(!document.hidden && focused);
  return () => {
    activityListeners.delete(listener);
    stopWatching();
  };
};
export const subscribeClock = (listener: Listener): (() => void) => {
  listeners.add(listener);
  watchActivity();
  if (listeners.size === 1) visibility();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
    }
    stopWatching();
  };
};

let observer: IntersectionObserver | undefined;
const observed = new Map<Element, (visible: boolean) => void>();
export const observeAvatar = (
  element: Element,
  callback: (visible: boolean) => void
): (() => void) => {
  if (typeof IntersectionObserver === "undefined") {
    callback(true);
    return () => {};
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries)
      observed.get(entry.target)?.(entry.isIntersecting);
  });
  observed.set(element, callback);
  observer.observe(element);
  return () => {
    observer?.unobserve(element);
    observed.delete(element);
    if (!observed.size) {
      observer?.disconnect();
      observer = undefined;
    }
  };
};

/** Visible avatar leases. Active speech wins over ambient idle in a long list. */
export const MAX_ANIMATED_AVATARS = 6;
const leases = new Map<
  symbol,
  { priority: number; notify(active: boolean): void; active: boolean }
>();
const reconcile = () => {
  const admitted = new Set(
    [...leases.entries()]
      .sort((a, b) => b[1].priority - a[1].priority)
      .slice(0, MAX_ANIMATED_AVATARS)
      .map(([id]) => id)
  );
  for (const [id, lease] of leases) {
    const active = admitted.has(id);
    if (lease.active !== active) {
      lease.active = active;
      lease.notify(active);
    }
  }
};
export const claimAnimation = (
  notify: (active: boolean) => void,
  priority: number
): (() => void) => {
  const id = Symbol();
  notify(false);
  leases.set(id, { priority, notify, active: false });
  reconcile();
  return () => {
    leases.delete(id);
    reconcile();
  };
};

export interface AvatarPointer {
  x: number;
  y: number;
  speed: number;
  at: number;
}
const pointers = new Set<(pointer: AvatarPointer) => void>();
let pointerFrame = 0;
let latestPointer: PointerEvent | null = null;
let previousPointer: AvatarPointer | null = null;
const movePointer = (event: PointerEvent) => {
  if (event.pointerType !== "mouse") return;
  latestPointer = event;
  if (pointerFrame) return;
  pointerFrame = requestAnimationFrame(() => {
    pointerFrame = 0;
    if (!latestPointer || document.hidden) return;
    const at = performance.now();
    const pointer = {
      x: latestPointer.clientX,
      y: latestPointer.clientY,
      at,
      speed: previousPointer
        ? Math.min(
            2,
            Math.hypot(
              latestPointer.clientX - previousPointer.x,
              latestPointer.clientY - previousPointer.y
            ) / Math.max(16, at - previousPointer.at)
          )
        : 0,
    };
    previousPointer = pointer;
    for (const notify of pointers) notify(pointer);
  });
};
export const subscribePointer = (
  notify: (pointer: AvatarPointer) => void
): (() => void) => {
  if (!pointers.size)
    document.addEventListener("pointermove", movePointer, { passive: true });
  pointers.add(notify);
  return () => {
    pointers.delete(notify);
    if (!pointers.size) {
      document.removeEventListener("pointermove", movePointer);
      cancelAnimationFrame(pointerFrame);
      pointerFrame = 0;
      latestPointer = null;
      previousPointer = null;
    }
  };
};
