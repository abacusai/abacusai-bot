import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";

import { SettingsSearch } from "#next/features/settings";
import { useMotionPreference } from "#next/lib/motion";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
/** Settings take over the sidebar slot (canvas `SettingsInPlace`). */
export const Route = createFileRoute("/_shell/settings")({
  validateSearch: SettingsSearch,
  staticData: { area: "settings", sidebar: "settings" },
  component: SettingsLayout,
});

function SettingsLayout() {
  const { focus } = Route.useSearch();
  const motion = useMotionPreference();
  const navigate = useAppNavigate();
  useEffect(() => {
    if (!focus) return;
    const timer = setTimeout(() => {
      const element = document.querySelector<HTMLElement>(
        `[data-setting-id="${CSS.escape(focus)}"]`
      );
      if (!element) return;
      element.scrollIntoView({ block: "center" });
      element
        .querySelector<HTMLElement>("button,input,select,textarea")
        ?.focus();
      if (motion !== "reduced")
        element.animate(
          [
            { backgroundColor: "var(--accent)" },
            { backgroundColor: "transparent" },
          ],
          { duration: 1200 }
        );
      void navigate({
        search: (old) => ({ ...old, focus: undefined }),
        replace: true,
        transition: "none",
      });
    }, 100);
    return () => clearTimeout(timer);
  }, [focus, navigate, motion]);
  return <Outlet />;
}
