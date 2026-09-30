/**
 * A modal overlay hides the rest of the page with `aria-hidden="true"`
 * (Base UI's outside-element marking), which leaves the shell's links and
 * buttons focusable behind it: axe `aria-hidden-focus` on the rail
 * (Claude impl r1 #10). This makes any element that gets `aria-hidden="true"`
 * while it is or holds focusable content `inert` as well, and lifts only the
 * `inert` it set once the attribute goes.
 *
 * Covered (Codex impl r2 #4): a hidden element that is itself focusable, a
 * subtree inserted already hidden, and focusable content that arrives (or
 * becomes focusable) inside a hidden region later. Base UI's focus guards are
 * `aria-hidden` and focusable on purpose (they close the modal's focus
 * trap), so they are never made inert.
 */
const GUARD = "data-base-ui-focus-guard";
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
]
  .map((part) => `${part}:not([${GUARD}])`)
  .join(", ");
const HIDDEN = '[aria-hidden="true"]';

const MARK = "data-inert-by-hidden";

const holdsFocusable = (element: HTMLElement): boolean =>
  element.matches(FOCUSABLE) || element.querySelector(FOCUSABLE) != null;

const apply = (element: Element): void => {
  if (!(element instanceof HTMLElement) || element.hasAttribute(GUARD)) return;
  const hidden = element.getAttribute("aria-hidden") === "true";
  if (hidden && !element.hasAttribute("inert") && holdsFocusable(element)) {
    element.setAttribute("inert", "");
    element.setAttribute(MARK, "");
  } else if (!hidden && element.hasAttribute(MARK)) {
    element.removeAttribute("inert");
    element.removeAttribute(MARK);
  }
};

/** The hidden regions an inserted or changed node belongs to or carries. */
const applyAround = (node: Node): void => {
  const element = node instanceof Element ? node : node.parentElement;
  if (element == null) return;
  const region = element.closest(HIDDEN);
  if (region != null) apply(region);
  for (const inner of element.querySelectorAll(HIDDEN)) apply(inner);
};

export const inertWhileHidden = (root: HTMLElement = document.body) => {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "childList") {
        for (const node of record.addedNodes) applyAround(node);
      } else if (record.attributeName === "aria-hidden") {
        apply(record.target as Element);
      } else {
        // A child that became focusable (href, disabled, tabindex).
        applyAround(record.target);
      }
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-hidden", "href", "disabled", "tabindex"],
  });
  for (const element of root.querySelectorAll(HIDDEN)) apply(element);
  return () => {
    observer.disconnect();
    for (const element of root.querySelectorAll(`[${MARK}]`)) {
      element.removeAttribute("inert");
      element.removeAttribute(MARK);
    }
  };
};
