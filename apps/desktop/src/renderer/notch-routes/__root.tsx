import {
  createRootRouteWithContext,
  Outlet,
  useRouter,
  Navigate,
} from "@tanstack/react-router";
import { useRef } from "react";

import { NotchShell } from "#renderer/features/notch";
import type { NotchPresentation } from "#renderer/features/notch";
import type { NotchRouterContext } from "#renderer/notch-context";
const Root = () => {
  const router = useRouter();
  const context = router.options.context as unknown as NotchRouterContext;
  const previousExpanded = useRef(false);
  const navigate = async (p: NotchPresentation) => {
    const type =
      p.expanded === previousExpanded.current
        ? "notch-swap"
        : p.expanded
          ? "notch-expand"
          : "notch-contract";
    const path = p.route.replace("$id", encodeURIComponent(p.sessionId ?? ""));
    await router.navigate({
      href: path,
      replace: true,
      state: { navIntent: { id: crypto.randomUUID(), type } },
    });
    previousExpanded.current = p.expanded;
  };
  return (
    <NotchShell context={context} navigate={navigate}>
      <Outlet />
    </NotchShell>
  );
};
export const Route = createRootRouteWithContext<NotchRouterContext>()({
  component: Root,
  notFoundComponent: () => <Navigate to={"/idle" as never} replace />,
});
