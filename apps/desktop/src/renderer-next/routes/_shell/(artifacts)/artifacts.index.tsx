import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { ArtifactsPage } from "#next/features/artifacts";
import { TopBarSlot } from "#next/features/shell";
import { ignoreLoadError } from "#next/lib/navigation/loaders";
import { ArtifactsSearch } from "#next/lib/navigation/search";

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
