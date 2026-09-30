/**
 * A modal overlay hides the rest of the page with `aria-hidden="true"`
 * (Base UI's outside-element marking), which leaves the shell's links and
 * buttons focusable behind it: axe `aria-hidden-focus` on the rail
 * (Claude impl r1 #10). This makes any element that gets `aria-hidden="true"`
 * while it holds focusable content `inert` as well, and lifts only the
 * `inert` it set once the attribute goes.
 */
const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

const MARK = "data-inert-by-hidden";

const apply = (element: Element): void => {
  if (!(element instanceof HTMLElement)) return;
  const hidden = element.getAttribute("aria-hidden") === "true";
  if (
    hidden &&
    !element.hasAttribute("inert") &&
    element.querySelector(FOCUSABLE) != null
  ) {
    element.setAttribute("inert", "");
    element.setAttribute(MARK, "");
  } else if (!hidden && element.hasAttribute(MARK)) {
    element.removeAttribute("inert");
    element.removeAttribute(MARK);
  }
};

export const inertWhileHidden = (root: HTMLElement = document.body) => {
  const observer = new MutationObserver((records) => {
    for (const record of records) apply(record.target as Element);
  });
  observer.observe(root, {
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-hidden"],
  });
  for (const element of root.querySelectorAll('[aria-hidden="true"]'))
    apply(element);
  return () => {
    observer.disconnect();
    for (const element of root.querySelectorAll(`[${MARK}]`)) {
      element.removeAttribute("inert");
      element.removeAttribute(MARK);
    }
  };
};
