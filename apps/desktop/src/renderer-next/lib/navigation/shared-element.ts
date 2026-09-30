/**
 * Cross-route shared elements (spec 01 §6.7 amendment; spec 03 §16.2): the
 * route change is the router's document-level view transition, which React
 * `<ViewTransition name>` cannot join. An element that should morph across
 * routes (the bot identity) carries a CSS `view-transition-name` instead:
 * the browser pairs the old and the new element with that name inside the
 * router's transition. The class `shared` lets tokens.css time the group.
 *
 * The style is computed during render, so it is on the element when the
 * router's transition captures the new state. A name must be unique in the
 * document while a transition captures it; dev builds log a second mount.
 */
import { useEffect, type CSSProperties } from "react";

const MOUNTED = new Map<string, number>();

/** The inline style for one named shared element, or none. */
export const sharedElementStyle = (name: string | null): CSSProperties =>
  name == null
    ? {}
    : ({
        viewTransitionName: name,
        viewTransitionClass: "shared",
      } as CSSProperties);

/** How many mounted elements carry `name` now (dev checks, tests). */
export const sharedElementMounts = (name: string): number =>
  MOUNTED.get(name) ?? 0;

/** `style` for the element that carries `name` (null: no name). */
export const useSharedElementName = (name: string | null): CSSProperties => {
  useEffect(() => {
    if (name == null) return;
    const count = MOUNTED.get(name) ?? 0;
    MOUNTED.set(name, count + 1);
    if (count > 0 && import.meta.env.DEV)
      console.error(`[renderer-next] view-transition-name ${name} is in use`);
    return () => {
      const left = (MOUNTED.get(name) ?? 1) - 1;
      if (left === 0) MOUNTED.delete(name);
      else MOUNTED.set(name, left);
    };
  }, [name]);
  return sharedElementStyle(name);
};
