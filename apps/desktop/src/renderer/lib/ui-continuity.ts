/**
 * DOM state that survives a renderer swap: focus, caret, scroll offsets and
 * text in transient fields. The swap (main/renderer-host.ts) calls
 * `window.__captureUiContinuity` on the outgoing renderer and hands the result
 * to `window.__restoreUiContinuity` on the incoming one, which retries as the
 * app mounts and stands down once the user interacts. Never written to disk.
 */

interface FieldEntry {
  selector: string;
  value: string;
}

interface ScrollEntry {
  left: number;
  selector: string;
  top: number;
}

export interface UiContinuitySnapshot {
  /** Absent in a snapshot captured by an older bundle. */
  fields?: FieldEntry[];
  focus?: {
    selector: string;
    selectionEnd?: number;
    selectionStart?: number;
  };
  scrolls: ScrollEntry[];
}

const MAX_SCROLLERS = 20;
const MAX_FIELDS = 20;
const MAX_FIELD_VALUE_LENGTH = 4_096;
const RESTORE_WINDOW_MS = 5_000;
const RESTORE_INTERVAL_MS = 250;

const GENERATED_ID = /[:»]|^base-ui-|^radix-/u;

// Data attributes and names come before ids: useId and headless-UI ids depend
// on render order, which a fresh renderer assigns differently.
const selectorFor = (element: Element): string | null => {
  const parts: string[] = [];
  let node: Element | null = element;

  while (node !== null && node !== document.documentElement) {
    for (const attribute of ["data-testid", "data-id", "name"]) {
      const value = node.getAttribute(attribute);

      if (value !== null) {
        parts.unshift(
          `${node.tagName.toLowerCase()}[${attribute}="${CSS.escape(value)}"]`
        );

        return parts.join(" > ");
      }
    }

    if (node.id !== "" && !GENERATED_ID.test(node.id)) {
      parts.unshift(`#${CSS.escape(node.id)}`);

      return parts.join(" > ");
    }

    const parent: Element | null = node.parentElement;
    const index = parent === null ? 0 : [...parent.children].indexOf(node) + 1;

    parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${index})`);
    node = parent;
  }

  return parts.length === 0 ? null : parts.join(" > ");
};

const isTextField = (
  element: Element
): element is HTMLInputElement | HTMLTextAreaElement =>
  element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;

// Text the user may have typed; never secrets or file paths. A password field
// gets focus back but comes back empty.
const carriesText = (
  element: Element
): element is HTMLInputElement | HTMLTextAreaElement => {
  if (element instanceof HTMLTextAreaElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;

  return !["checkbox", "file", "hidden", "password", "radio"].includes(
    element.type
  );
};

// The prototype's native setter (a controlled component overrides the instance
// one) plus an input event, so React's onChange runs.
const setFieldValue = (
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string
): void => {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

  if (setter === undefined) return;

  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
};

export const captureUiContinuity = (): UiContinuitySnapshot => {
  const snapshot: UiContinuitySnapshot = { fields: [], scrolls: [] };
  const active = document.activeElement;

  if (active !== null && active !== document.body) {
    const selector = selectorFor(active);

    if (selector !== null) {
      snapshot.focus = { selector };

      if (isTextField(active)) {
        snapshot.focus.selectionStart = active.selectionStart ?? undefined;
        snapshot.focus.selectionEnd = active.selectionEnd ?? undefined;
      }
    }
  }

  for (const element of document.querySelectorAll("*")) {
    if (snapshot.scrolls.length >= MAX_SCROLLERS) break;
    if (element.scrollTop === 0 && element.scrollLeft === 0) continue;

    const selector = selectorFor(element);

    if (selector !== null) {
      snapshot.scrolls.push({
        left: element.scrollLeft,
        selector,
        top: element.scrollTop,
      });
    }
  }

  const fields: FieldEntry[] = [];

  for (const element of document.querySelectorAll("input, textarea")) {
    if (fields.length >= MAX_FIELDS) break;
    if (!carriesText(element)) continue;
    // No defaultValue heuristic: React mirrors a controlled value into it.
    if (element.value === "") continue;
    if (element.value.length > MAX_FIELD_VALUE_LENGTH) continue;

    const selector = selectorFor(element);

    if (selector !== null) {
      fields.push({ selector, value: element.value });
    }
  }

  snapshot.fields = fields;

  return snapshot;
};

// Resolves after the first pass; retries continue for elements mounting later.
export const restoreUiContinuity = (
  snapshot: UiContinuitySnapshot
): Promise<void> => {
  const pendingFields = new Set(snapshot.fields ?? []);
  const pendingScrolls = new Set(snapshot.scrolls);
  let pendingFocus = snapshot.focus;
  let stopped = false;
  const deadline = Date.now() + RESTORE_WINDOW_MS;

  const stop = (): void => {
    stopped = true;

    for (const event of ["keydown", "pointerdown", "wheel"] as const) {
      window.removeEventListener(event, stop, { capture: true });
    }
  };

  // The user acting in the new renderer outranks where they were in the old.
  for (const event of ["keydown", "pointerdown", "wheel"] as const) {
    window.addEventListener(event, stop, { capture: true, passive: true });
  }

  const attempt = (): void => {
    if (stopped) return;

    for (const entry of pendingFields) {
      const element = document.querySelector(entry.selector);

      if (element === null) continue;

      if (carriesText(element) && element.value === "") {
        setFieldValue(element, entry.value);
      }

      // Found but already holding text: durable state or the user owns it.
      pendingFields.delete(entry);
    }

    for (const entry of pendingScrolls) {
      const element = document.querySelector(entry.selector);

      if (element === null) continue;

      element.scrollTop = entry.top;
      element.scrollLeft = entry.left;

      if (element.scrollTop === entry.top) pendingScrolls.delete(entry);
    }

    if (pendingFocus !== undefined) {
      const element = document.querySelector(pendingFocus.selector);

      if (element instanceof HTMLElement) {
        element.focus();

        if (isTextField(element) && pendingFocus.selectionStart !== undefined) {
          try {
            element.setSelectionRange(
              pendingFocus.selectionStart,
              pendingFocus.selectionEnd ?? pendingFocus.selectionStart
            );
          } catch {
            // Some input types refuse selections; focus alone is enough.
          }
        }

        pendingFocus = undefined;
      }
    }

    if (
      (pendingFields.size > 0 ||
        pendingScrolls.size > 0 ||
        pendingFocus !== undefined) &&
      Date.now() < deadline
    ) {
      setTimeout(attempt, RESTORE_INTERVAL_MS);
    } else {
      stop();
    }
  };

  return new Promise((resolve) => {
    attempt();
    // One macrotask so the input events have dispatched first.
    setTimeout(resolve, 0);
  });
};

declare global {
  interface Window {
    __captureUiContinuity?: () => UiContinuitySnapshot;
    __restoreUiContinuity?: (snapshot: UiContinuitySnapshot) => Promise<void>;
  }
}

/** Expose the pair the swap drives; called once at renderer start. */
export const installUiContinuity = (): void => {
  window.__captureUiContinuity = captureUiContinuity;
  window.__restoreUiContinuity = restoreUiContinuity;
};
