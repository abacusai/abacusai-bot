import {
  createRootRouteWithContext,
  Outlet,
  useRouter,
  Navigate,
} from "@tanstack/react-router";

import { NotchShell } from "#next/features/notch";
import type { NotchPresentation } from "#next/features/notch/presenter";
import type { NotchRouterContext } from "#next/notch-context";
const Root = () => {
  const router = useRouter();
  const context = router.options.context as unknown as NotchRouterContext;
  const navigate = async (p: NotchPresentation) => {
    const path = p.route.replace("$id", encodeURIComponent(p.sessionId ?? ""));
    await router.navigate({
      href: path,
      replace: true,
      state: { navIntent: { id: crypto.randomUUID(), type: "notch-swap" } },
    });
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
