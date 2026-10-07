/** One low-frequency clock and one observer for the whole avatar population.
 * Motion owns spring frames. No clock subscribers for tiny/offscreen avatars. */
type Listener = (seconds: number, visible: boolean) => void;
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | undefined;
const tick = () => {
  const visible = !document.hidden;
  for (const listener of listeners) listener(performance.now() / 1000, visible);
};
const visibility = () => {
  if (document.hidden) {
    clearInterval(timer);
    timer = undefined;
  } else if (!timer && listeners.size) timer = setInterval(tick, 100);
  tick();
};
export const subscribeClock = (listener: Listener): (() => void) => {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", visibility);
    visibility();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
      document.removeEventListener("visibilitychange", visibility);
    }
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
