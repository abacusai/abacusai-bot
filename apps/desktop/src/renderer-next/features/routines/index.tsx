/**
 * Routines, phase 1 (spec 01 §7.3): the sidebar lists names and whether each
 * is on; the list body stays mounted under the masked create sheet
 * (`routines._list`), stats and auto-replies are phase 5.
 */
import { useLiveQuery } from "@tanstack/react-db";
import { useParams } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "#next/components/empty-state";
import { NavList } from "#next/components/nav-list";
import { RouteSheet } from "#next/components/route-sheet";
import { useCollections } from "#next/data/collections";
import { useCollectionStatus } from "#next/data/collections/status";
import { AppLink } from "#next/lib/navigation/app-link";
import { Button } from "#next/ui/button";

export const RoutinesSidebar = () => {
  const { t } = useTranslation();
  const collections = useCollections();
  const { data } = useLiveQuery({
    query: (q) =>
      q.from({ r: collections.routines }).orderBy(({ r }) => r.name, "asc"),
  });
  const status = useCollectionStatus(collections.routines);
  const params = useParams({ strict: false }) as { routineId?: string };

  return (
    <NavList.Root label={t("routines.sidebar.label")}>
      <NavList.Header title={t("routines.sidebar.label")}>
        <NavList.Action
          label={t("routines.sidebar.new")}
          render={<AppLink to="/routines/new" transition="none" />}
        >
          <Plus />
        </NavList.Action>
      </NavList.Header>
      {status === "error" ? (
        <NavList.Error
          message={t("shell.sidebar.loadError")}
          retryLabel={t("shell.sidebar.retry")}
          onRetry={() => void collections.routines.utils.resync()}
        />
      ) : status !== "ready" ? (
        <NavList.Skeleton />
      ) : (data ?? []).length === 0 ? (
        <p className="text-muted-foreground px-2 pt-2 text-xs">
          {t("routines.sidebar.empty")}
        </p>
      ) : (
        <div role="list" className="flex flex-col gap-0.5 pt-1">
          {(data ?? []).map((routine) => (
            <NavList.Item
              key={routine.id}
              to="/routines/$routineId"
              params={{ routineId: routine.id }}
              active={params.routineId === routine.id}
              title={routine.name}
              meta={routine.enabled ? undefined : t("routines.sidebar.paused")}
            />
          ))}
        </div>
      )}
    </NavList.Root>
  );
};

/** The routines page body (canvas `RoutineStates`): phase 1 empty state. */
export const RoutinesListBody = () => {
  const { t } = useTranslation();
  return (
    <div
      data-testid="routines-list-body"
      className="flex size-full items-center justify-center"
    >
      <EmptyState
        icon="routines"
        title={t("routines.page.emptyTitle")}
        description={t("routines.page.emptyDescription")}
        action={
          <Button
            size="sm"
            nativeButton={false}
            render={<AppLink to="/routines/new" transition="none" />}
          >
            {t("routines.sidebar.new")}
          </Button>
        }
      />
    </div>
  );
};

export const RoutinePage = () => {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon="routines"
      title={t("routines.page.routineTitle")}
      description={t("routines.page.routineDescription")}
    />
  );
};

export const RoutineCreateSheet = () => {
  const { t } = useTranslation();
  return (
    <RouteSheet
      title={t("routines.page.createTitle")}
      description={t("routines.page.createDescription")}
      fallbackHref="/routines"
    />
  );
};
