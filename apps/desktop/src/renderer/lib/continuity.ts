import { flushSync } from "react-dom";

import {
  captureDrafts,
  restoreDrafts,
  type DraftSnapshot,
} from "./continuity/registry";
export interface UiContinuitySnapshot {
  drafts: DraftSnapshot;
  focus?: {
    id: string;
    start?: number;
    end?: number;
    direction?: "forward" | "backward" | "none";
  };
  scrolls: Array<{
    id: string;
    top: number;
    left: number;
    anchor?: string;
    offset?: number;
  }>;
}
const find = (attribute: string, id: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>(`[${attribute}]`)].find(
    (e) => e.getAttribute(attribute) === id
  );
export const captureUiContinuity = ():
  | UiContinuitySnapshot
  | { tooLarge: true } => {
  const snapshot: UiContinuitySnapshot = {
    drafts: captureDrafts(),
    scrolls: [],
  };
  const active = document.activeElement;
  const id = active?.getAttribute("data-continuity-id");
  if (id) {
    snapshot.focus = { id };
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement
    ) {
      snapshot.focus.start = active.selectionStart ?? undefined;
      snapshot.focus.end = active.selectionEnd ?? undefined;
      snapshot.focus.direction = active.selectionDirection ?? undefined;
    }
  }
  for (const scroller of [
    ...document.querySelectorAll<HTMLElement>("[data-continuity-scroll]"),
  ].slice(0, 20)) {
    const rect = scroller.getBoundingClientRect();
    const anchor = [
      ...scroller.querySelectorAll<HTMLElement>("[data-message-id]"),
    ].find((e) => e.getBoundingClientRect().bottom > rect.top);
    snapshot.scrolls.push({
      id: scroller.getAttribute("data-continuity-scroll")!,
      top: scroller.scrollTop,
      left: scroller.scrollLeft,
      ...(anchor
        ? {
            anchor: anchor.getAttribute("data-message-id")!,
            offset: anchor.getBoundingClientRect().top - rect.top,
          }
        : {}),
    });
  }
  return new TextEncoder().encode(JSON.stringify(snapshot)).byteLength >
    4 * 1024 * 1024
    ? { tooLarge: true }
    : snapshot;
};
export const restoreUiContinuity = async (
  snapshot: UiContinuitySnapshot
): Promise<void> => {
  flushSync(() => restoreDrafts(snapshot.drafts));
  // The hidden candidate does not receive animation frames reliably. Macrotasks
  // let React commit subscribers and virtual scrollers before DOM restoration.
  await new Promise<void>((r) => setTimeout(r, 0));
  for (const entry of snapshot.scrolls) {
    const scroller = find("data-continuity-scroll", entry.id);
    if (!scroller) continue;
    const anchor = [
      ...scroller.querySelectorAll<HTMLElement>("[data-message-id]"),
    ].find((e) => e.getAttribute("data-message-id") === entry.anchor);
    scroller.scrollTop =
      anchor && entry.offset != null
        ? scroller.scrollTop +
          anchor.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top -
          entry.offset
        : entry.top;
    scroller.scrollLeft = entry.left;
  }
  const focus = snapshot.focus;
  if (focus) {
    const element = find("data-continuity-id", focus.id);
    element?.focus({ preventScroll: true });
    if (
      (element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement) &&
      focus.start != null
    ) {
      try {
        element.setSelectionRange(
          focus.start,
          focus.end ?? focus.start,
          focus.direction
        );
      } catch {
        /* Non-text inputs have no caret. */
      }
    }
  }
  await new Promise<void>((r) => setTimeout(r, 0));
};
declare global {
  interface Window {
    __captureUiContinuity?: typeof captureUiContinuity;
    __restoreUiContinuity?: typeof restoreUiContinuity;
  }
}
export const installUiContinuity = (): void => {
  window.__captureUiContinuity = captureUiContinuity;
  window.__restoreUiContinuity = restoreUiContinuity;
};
