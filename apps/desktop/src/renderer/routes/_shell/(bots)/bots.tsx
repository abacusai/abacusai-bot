import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { LayoutGroup } from "motion/react";
import { useTranslation } from "react-i18next";

import { botsQueries } from "#renderer/features/bots/data/queries";
import { Button } from "#renderer/ui/button";
const BotsLayout = () => (
  <LayoutGroup id="bots">
    <Outlet />
  </LayoutGroup>
);
const BotsAreaError = () => {
  const { t } = useTranslation();
  const router = useRouter();
  const { db } = Route.useRouteContext();
  return (
    <div
      role="alert"
      className="flex size-full flex-col items-center justify-center gap-3"
    >
      <p>{t("shell.sidebar.loadError")}</p>
      <Button
        onClick={() =>
          void Promise.all([
            db.collections.bots.utils.resync(),
            db.collections.routines.utils.resync(),
          ])
            .then(() => router.invalidate())
            .catch(() => undefined)
        }
      >
        {t("bots.errors.retry")}
      </Button>
    </div>
  );
};
export const Route = createFileRoute("/_shell/(bots)/bots")({
  staticData: { area: "bots", sidebar: "bots" },
  loader: async ({ context }) => {
    await Promise.all([
      context.db.collections.bots.preload(),
      context.db.collections.routines.preload(),
      context.queryClient.ensureQueryData(
        botsQueries(context.transport.orpc).chatPreviews()
      ),
    ]);
  },
  component: BotsLayout,
  errorComponent: BotsAreaError,
});
