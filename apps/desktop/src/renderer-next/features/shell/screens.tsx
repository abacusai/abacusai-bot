/**
 * Whole-window screens: the boot failure (no router, no collections), the
 * root error and not-found components, and the `_bare` layout's drag strip.
 */
import { Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { EmptyState } from "#next/components/empty-state";
import { AppLink } from "#next/lib/navigation/app-link";
import { Button } from "#next/ui/button";

/** A title-bar-high strip that drags the window (`_bare` routes). */
export const WindowDragRegion = () => (
  <div
    data-slot="window-drag-region"
    aria-hidden="true"
    className="titlebar-drag fixed inset-x-0 top-0 z-10 h-(--toolbar-h) pr-(--titlebar-end) pl-(--titlebar-x)"
  />
);

export const BareLayout = () => (
  <div
    data-slot="bare"
    className="bg-background text-foreground relative h-dvh"
  >
    <WindowDragRegion />
    <Outlet />
  </div>
);

const reload = (): void => window.location.reload();

/**
 * Boot failed before the router existed: a static tree with a Reload button.
 * The copy is passed in (i18n may be all that loaded).
 */
export const BootFailure = ({
  title,
  description,
  reloadLabel,
  detail,
}: {
  title: string;
  description: string;
  reloadLabel: string;
  detail?: string;
}) => (
  <div
    data-slot="boot-failure"
    className="bg-background text-foreground flex h-dvh flex-col items-center justify-center"
  >
    <WindowDragRegion />
    <EmptyState
      title={title}
      description={description}
      action={
        <Button onClick={reload} className="titlebar-nodrag">
          {reloadLabel}
        </Button>
      }
    />
    {import.meta.env.DEV && detail != null && (
      <pre className="text-muted-foreground mt-4 max-w-lg text-xs whitespace-pre-wrap">
        {detail}
      </pre>
    )}
  </div>
);

export const RootError = ({ error }: { error: unknown }) => {
  const { t } = useTranslation();
  return (
    <BootFailure
      title={t("errors.genericTitle")}
      description={t("errors.genericDescription")}
      reloadLabel={t("errors.reload")}
      detail={
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }
    />
  );
};

export const NotFound = () => {
  const { t } = useTranslation();
  return (
    <div className="bg-background flex size-full min-h-dvh items-center justify-center">
      <EmptyState
        title={t("errors.notFoundTitle")}
        description={t("errors.notFoundDescription")}
        action={
          <Button
            size="sm"
            render={<AppLink to="/bots/new" transition="nav-lateral" />}
          >
            {t("errors.goHome")}
          </Button>
        }
      />
    </div>
  );
};
