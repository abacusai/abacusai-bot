import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { ArtifactsPage } from "#renderer/features/artifacts";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";
import { ignoreLoadError } from "#renderer/lib/navigation/loaders";
import { ArtifactsSearch } from "#renderer/lib/navigation/search";

const ArtifactsRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("shell.rail.artifacts")}
        </span>
      </TopBarSlot>
      <ArtifactsPage />
    </>
  );
};

export const Route = createFileRoute("/_shell/(artifacts)/artifacts/")({
  search: {
    middlewares: [stripSearchParams({ view: "grid", sort: "newest" })],
  },
  validateSearch: ArtifactsSearch,
  loaderDeps: ({ search }) => ({
    type: search.type,
    from: search.from,
    q: search.q,
  }),
  loader: ({ context }) =>
    context.db.collections.artifacts.preload().catch(ignoreLoadError),
  component: ArtifactsRoute,
});
