import type { DockviewApi } from "dockview-react";

/** Dockview owns pointer dragging; its public sizing API adds keyboard/reset support. */
export const enhanceDockSplitters = (
  element: HTMLElement,
  api: DockviewApi
) => {
  const orient = (sash: HTMLElement) =>
    sash.parentElement?.parentElement?.classList.contains("dv-horizontal") ??
    true;
  const refresh = () => {
    for (const sash of element.querySelectorAll<HTMLElement>(".dv-sash")) {
      sash.tabIndex = 0;
      sash.setAttribute("role", "separator");
      sash.setAttribute(
        "aria-orientation",
        orient(sash) ? "vertical" : "horizontal"
      );
    }
  };
  const resize = (sash: HTMLElement, delta: number | null) => {
    const horizontal = orient(sash);
    const rect = sash.getBoundingClientRect();
    const edge = horizontal
      ? rect.left + rect.width / 2
      : rect.top + rect.height / 2;
    const groups = api.groups.map((group) => ({
      group,
      rect: group.element.getBoundingClientRect(),
    }));
    const before = groups
      .filter(({ rect: pane }) =>
        horizontal
          ? pane.right <= edge + 8 &&
            pane.bottom > rect.top &&
            pane.top < rect.bottom
          : pane.bottom <= edge + 8 &&
            pane.right > rect.left &&
            pane.left < rect.right
      )
      .sort((a, b) =>
        horizontal ? b.rect.right - a.rect.right : b.rect.bottom - a.rect.bottom
      )[0];
    if (!before) return;
    const size = horizontal ? before.rect.width : before.rect.height;
    const after = groups.find(({ rect: pane }) =>
      horizontal
        ? Math.abs(pane.left - edge) <= 8 && pane.top === before.rect.top
        : Math.abs(pane.top - edge) <= 8 && pane.left === before.rect.left
    );
    const reset = after
      ? (size + (horizontal ? after.rect.width : after.rect.height)) / 2
      : size;
    before.group.api.setSize(
      horizontal
        ? { width: delta == null ? reset : size + delta }
        : { height: delta == null ? reset : size + delta }
    );
  };
  const keydown = (event: KeyboardEvent) => {
    const sash =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>(".dv-sash")
        : null;
    if (!sash) return;
    const keys = orient(sash)
      ? ["ArrowLeft", "ArrowRight"]
      : ["ArrowUp", "ArrowDown"];
    if (!keys.includes(event.key) && event.key !== "Home") return;
    event.preventDefault();
    resize(
      sash,
      event.key === "Home"
        ? null
        : (event.key === keys[0] ? -1 : 1) * (event.shiftKey ? 64 : 16)
    );
  };
  const reset = (event: MouseEvent) => {
    const sash =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>(".dv-sash")
        : null;
    if (sash) resize(sash, null);
  };
  const observer = new MutationObserver(refresh);
  observer.observe(element, { childList: true, subtree: true });
  refresh();
  element.addEventListener("keydown", keydown);
  element.addEventListener("dblclick", reset);
  return () => {
    observer.disconnect();
    element.removeEventListener("keydown", keydown);
    element.removeEventListener("dblclick", reset);
  };
};
