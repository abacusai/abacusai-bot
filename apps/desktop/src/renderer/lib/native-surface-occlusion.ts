const OCCLUDER_SELECTOR = [
  '[data-slot="dialog-overlay"]',
  '[data-slot="alert-dialog-overlay"]',
  '[data-slot="dialog-content"]',
  '[data-slot="alert-dialog-content"]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="popover-content"]',
  '[data-slot="select-content"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
].join(",");

type OcclusionListener = () => void;

const listeners = new Set<OcclusionListener>();
let observer: MutationObserver | null = null;
let notificationQueued = false;

const isRendered = (
  element: Element,
  { ariaHiddenCounts = true }: { ariaHiddenCounts?: boolean } = {}
): boolean => {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  if (element.hidden || element.closest("[hidden]")) return false;
  // Optional: a dialog library leaving the app root aria-hidden would
  // otherwise park the native view for good.
  if (ariaHiddenCounts && element.closest('[aria-hidden="true"]')) return false;
  const style = getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    Number.parseFloat(style.opacity || "1") === 0
  ) {
    return false;
  }
  const bounds = element.getBoundingClientRect();
  return bounds.width > 0 && bounds.height > 0;
};

const notify = (): void => {
  if (notificationQueued) return;
  notificationQueued = true;
  queueMicrotask(() => {
    notificationQueued = false;
    for (const listener of listeners) listener();
  });
};

const start = (): void => {
  if (observer != null) return;
  observer = new MutationObserver(notify);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      "aria-hidden",
      "class",
      "data-closed",
      "data-open",
      "hidden",
      "style",
    ],
  });
  window.addEventListener("hashchange", notify);
  window.addEventListener("popstate", notify);
  window.addEventListener("resize", notify);
  window.addEventListener("scroll", notify, true);
  document.addEventListener("visibilitychange", notify);
};

const stop = (): void => {
  if (observer == null) return;
  observer.disconnect();
  observer = null;
  notificationQueued = false;
  window.removeEventListener("hashchange", notify);
  window.removeEventListener("popstate", notify);
  window.removeEventListener("resize", notify);
  window.removeEventListener("scroll", notify, true);
  document.removeEventListener("visibilitychange", notify);
};

const overlaps = (a: DOMRect, b: DOMRect): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** The rendered overlays that would draw under the native view. */
const occludersOf = (host: HTMLElement | null): Element[] =>
  [...document.querySelectorAll(OCCLUDER_SELECTOR)].filter((element) => {
    if (!isRendered(element)) return false;
    // An overlay off to the side takes nothing from the pane.
    return host == null
      ? true
      : overlaps(element.getBoundingClientRect(), host.getBoundingClientRect());
  });

export const hasNativeSurfaceOccluder = (
  host: HTMLElement | null = null
): boolean => occludersOf(host).length > 0;

export const isNativeSurfaceHostVisible = (
  host: HTMLElement | null
): boolean => {
  if (host == null || document.visibilityState === "hidden") return false;
  if (!isRendered(host, { ariaHiddenCounts: false })) return false;
  const bounds = host.getBoundingClientRect();
  return (
    bounds.right > 0 &&
    bounds.bottom > 0 &&
    bounds.left < window.innerWidth &&
    bounds.top < window.innerHeight
  );
};

/** For a log line when the native view stays off screen. */
export const describeNativeSurfaceOcclusion = (
  host: HTMLElement | null
): string => {
  const reasons: string[] = [];
  if (document.visibilityState === "hidden") reasons.push("window hidden");
  if (host == null) reasons.push("no host");
  else if (!isRendered(host, { ariaHiddenCounts: false }))
    reasons.push("host not rendered");
  else {
    const bounds = host.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1) reasons.push("host has no size");
  }
  for (const element of occludersOf(host)) {
    const role = element.getAttribute("role") ?? "";
    const slot = element.getAttribute("data-slot") ?? "";
    reasons.push(`overlay ${element.tagName.toLowerCase()} ${slot || role}`);
  }
  return reasons.join("; ") || "none";
};

export const subscribeNativeSurfaceEnvironment = (
  listener: OcclusionListener
): (() => void) => {
  listeners.add(listener);
  start();
  listener();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
};
