import {
  useLocation,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { Component, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "#renderer/components/empty-state";
import { Spinner } from "#renderer/components/spinner";
import { Button } from "#renderer/ui/button";
import { Skeleton } from "#renderer/ui/skeleton";

/** A failure belongs to the smallest independently usable pane. */
export const PaneError = ({ reset }: Pick<ErrorComponentProps, "reset">) => {
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <div
      role="alert"
      className="flex size-full min-h-40 min-w-0 items-center justify-center p-6"
    >
      <EmptyState
        title={t("errors.genericTitle")}
        description={t("errors.genericDescription")}
        action={
          <Button
            onClick={() => {
              reset();
              void router.invalidate();
            }}
          >
            {t("phase5.retry")}
          </Button>
        }
      />
    </div>
  );
};

export class PaneBoundary extends Component<
  { children: ReactNode; resetKey?: string },
  { failed: boolean; resetKey?: string }
> {
  override state = { failed: false, resetKey: this.props.resetKey };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(
    props: { resetKey?: string },
    state: { resetKey?: string }
  ) {
    return props.resetKey !== state.resetKey
      ? { failed: false, resetKey: props.resetKey }
      : null;
  }
  override render() {
    return this.state.failed ? (
      <PaneError reset={() => this.setState({ failed: false })} />
    ) : (
      this.props.children
    );
  }
}

const Lines = () => (
  <div className="flex min-w-0 flex-1 flex-col gap-2">
    <Skeleton className="h-3 w-2/5" />
    <Skeleton className="h-3 w-3/4" />
  </div>
);
const Rows = ({ count = 4 }: { count?: number }) => (
  <div className="bg-card flex flex-col divide-y rounded-xl px-1">
    {Array.from({ length: count }, (_, n) => (
      <div key={n} className="flex min-h-[52px] items-center gap-4 px-3 py-3">
        <Lines />
        <Skeleton className="h-7 w-20 shrink-0" />
      </div>
    ))}
  </div>
);

/** Reserve the same page frame, header and composer space as the destination. */
export const RoutePending = () => {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { t } = useTranslation();
  const area = pathname.split("/")[1];
  const start = /\/(new|welcome)$/.test(pathname);
  let content: ReactNode;
  if (
    (area === "bots" || area === "sessions") &&
    !start &&
    !pathname.endsWith("/edit")
  ) {
    content = (
      <div className="flex size-full min-h-0 flex-col">
        <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col gap-6 px-4 pt-6">
          <div className="flex items-center gap-3">
            <Skeleton className="size-8 rounded-full" />
            <Skeleton className="h-4 w-40" />
          </div>
          <Skeleton className="h-16 w-2/3 self-end rounded-2xl" />
          <Lines />
        </div>
        <div className="mx-auto w-full max-w-[720px] px-4 pb-4">
          <Skeleton className="h-14 w-full rounded-2xl" />
        </div>
      </div>
    );
  } else if (area === "sessions" && start) {
    content = (
      <div className="flex size-full items-center justify-center px-6 py-8">
        <div className="flex w-full max-w-[680px] flex-col gap-6">
          <Skeleton className="mx-auto h-9 w-64" />
          <Skeleton className="h-32 w-full rounded-2xl" />
          <div>
            <Skeleton className="mb-2 h-4 w-24" />
            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <Skeleton key={n} className="h-20 rounded-2xl" />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  } else if (area === "bots" && start) {
    content = (
      <div className="mx-auto flex w-[calc(100%-48px)] max-w-[760px] flex-col items-center gap-5 py-8">
        <Skeleton className="size-24 rounded-full" />
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-[52px] w-full max-w-[480px] rounded-full" />
        <Skeleton className="h-7 w-full" />
        <div className="grid w-full grid-cols-2 gap-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <Skeleton key={n} className="h-32 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  } else if (area === "settings" || area === "library") {
    content = (
      <div className="mx-auto flex w-[min(680px,calc(100%-48px))] flex-col gap-4 pt-10 pb-16">
        <Skeleton className="h-7 w-48" />
        {area === "library" && <Skeleton className="mb-2 h-4 w-3/4" />}
        {area === "library" && /\/(tools|connectors)$/.test(pathname) && (
          <Skeleton className="h-9 w-full rounded-lg" />
        )}
        {area === "library" && pathname.endsWith("/connectors") && (
          <Skeleton className="h-14 w-full rounded-lg" />
        )}
        <Rows
          count={
            pathname.endsWith("/appearance")
              ? 5
              : pathname.endsWith("/general")
                ? 6
                : 4
          }
        />
        {!pathname.endsWith("/appearance") && <Rows />}
      </div>
    );
  } else if (area === "artifacts") {
    content = (
      <div className="flex size-full flex-col">
        <div className="flex h-14 shrink-0 items-center gap-3 px-5">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="ml-auto h-7 w-48" />
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2.5 p-5">
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <Skeleton key={n} className="h-[180px] rounded-xl" />
          ))}
        </div>
      </div>
    );
  } else if (area === "routines" || pathname.endsWith("/edit")) {
    content = (
      <div className="flex flex-col gap-5 p-6">
        <Skeleton className="h-10 w-2/3" />
        <Rows />
        <Skeleton className="h-32 w-full rounded-xl" />
      </div>
    );
  } else {
    content = (
      <div className="flex size-full min-h-40 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return (
    <div
      data-testid="pending-pane"
      data-pending-area={area}
      role="status"
      aria-label={t("common.loading")}
      className="size-full min-h-0 min-w-0 overflow-hidden"
    >
      <div aria-hidden="true" className="size-full">
        {content}
      </div>
    </div>
  );
};
