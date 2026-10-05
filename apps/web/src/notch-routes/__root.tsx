import {
  createRootRouteWithContext,
  Outlet,
  useRouter,
  Navigate,
} from "@tanstack/react-router";
import { useEffect } from "react";

import { usePrefs } from "#renderer/data/db/prefs";
import { NotchShell } from "#renderer/features/notch";
import type { NotchPresentation } from "#renderer/features/notch";
import { lookOf, notchTokens, resolveLook } from "#renderer/lib/look";
import { applyLook, CONTRAST_QUERY, useMedia } from "#renderer/lib/theme";
import type { NotchRouterContext } from "#renderer/notch-context";

/** Colour tokens a light-only theme must not bring into the dark notch. */
const KEEP =
  /^(radius|ui-font-family|chat-font-mono|font-mono|code-font-size)$/;

/**
 * The notch is always dark (it wraps the hardware notch): it takes the
 * chosen theme's dark variant and accent, with the OS's increased contrast,
 * or, for a light-only theme, only its fonts, sizes and corners. The shape
 * stays black; its text and controls are solved on black. Never remembered:
 * the boot look belongs to the main window.
 */
const NotchLook = () => {
  const appearance = usePrefs().appearance;
  const high = useMedia(CONTRAST_QUERY);
  useEffect(() => {
    const look = lookOf(appearance);
    const applied = resolveLook(look, "dark", high);
    const vars =
      applied.mode === "dark"
        ? applied.vars
        : Object.fromEntries(
            Object.entries(applied.vars).filter(([key]) => KEEP.test(key))
          );
    const dark = { ...applied, mode: "dark" as const, vars };
    applyLook(
      document,
      { ...dark, vars: { ...vars, ...notchTokens(dark) } },
      look.translucency
    );
  }, [appearance, high]);
  return null;
};
const Root = () => {
  const router = useRouter();
  const context = router.options.context as unknown as NotchRouterContext;
  const navigate = async (p: NotchPresentation) => {
    const path = p.route.replace("$id", encodeURIComponent(p.sessionId ?? ""));
    await router.navigate({
      href: path,
      replace: true,
    });
  };
  return (
    <>
      <NotchLook />
      <NotchShell context={context} navigate={navigate}>
        <Outlet />
      </NotchShell>
    </>
  );
};
export const Route = createRootRouteWithContext<NotchRouterContext>()({
  component: Root,
  notFoundComponent: () => <Navigate to={"/idle" as never} replace />,
});
