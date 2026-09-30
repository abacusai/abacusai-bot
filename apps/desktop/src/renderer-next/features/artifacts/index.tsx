/**
 * Artifacts, phase 1: a static filter sidebar writing `ArtifactsSearch`
 * (no data) and the empty state (canvas `ArtifactsStates`).
 */
import { useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { EmptyState } from "#next/components/empty-state";
import { NavList } from "#next/components/nav-list";
import { ARTIFACT_SOURCES, ARTIFACT_TYPES } from "#next/lib/navigation/search";

export const ArtifactsSidebar = () => {
  const { t } = useTranslation();
  const search = useSearch({ strict: false }) as {
    type?: string;
    from?: string;
  };
  return (
    <NavList.Root label={t("artifacts.sidebar.label")}>
      <NavList.Header title={t("artifacts.sidebar.label")} />
      <NavList.Group label={t("artifacts.sidebar.type")}>
        <NavList.Item
          to="/artifacts"
          search={{ from: search.from }}
          active={search.type == null}
          transition="none"
          title={t("artifacts.sidebar.all")}
        />
        {ARTIFACT_TYPES.map((type) => (
          <NavList.Item
            key={type}
            to="/artifacts"
            search={{ type, from: search.from }}
            active={search.type === type}
            transition="none"
            title={t(`artifacts.sidebar.types.${type}`)}
          />
        ))}
      </NavList.Group>
      <NavList.Group label={t("artifacts.sidebar.source")}>
        {ARTIFACT_SOURCES.map((from) => (
          <NavList.Item
            key={from}
            to="/artifacts"
            search={{ type: search.type, from }}
            active={search.from === from}
            transition="none"
            title={t(`artifacts.sidebar.sources.${from}`)}
          />
        ))}
      </NavList.Group>
    </NavList.Root>
  );
};

export const ArtifactsPage = () => {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon="artifacts"
      title={t("artifacts.page.emptyTitle")}
      description={t("artifacts.page.emptyDescription")}
    />
  );
};
