import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useAppContext } from "#renderer/lib/use-app-context";
import { Badge } from "#renderer/ui/badge";
import { Empty, EmptyDescription } from "#renderer/ui/empty";
import { Item, ItemGroup } from "#renderer/ui/item";
import { Skeleton } from "#renderer/ui/skeleton";

import { deliveredKey, hostedStatusKey, hostedUnread } from "./hosted";

/**
 * A hosted routine's results, read from the server: when each run finished,
 * how it went, where its message went, and what it said. Opening the page
 * marks its new results read.
 */
export const HostedResults = ({ row }: { row: RoutineRow }) => {
  const { t, i18n } = useTranslation();
  const { transport } = useAppContext();
  const lastAt = row.hosted?.lastRun?.at ?? null;
  const runs = useQuery(
    transport.orpc.routines.hostedRuns.queryOptions({ input: { id: row.id } })
  );
  const { refetch } = runs;
  // Opening the page marks its results seen; the query reads them itself.
  useEffect(() => {
    hostedUnread.read(row.id);
  }, [row.id]);
  // A new result moves the row's last run: read the list again, once.
  const shown = useRef({ id: row.id, at: lastAt });
  useEffect(() => {
    const before = shown.current;
    shown.current = { id: row.id, at: lastAt };
    // Another routine's page is a new query, read on its own.
    if (before.id !== row.id || before.at === lastAt) return;
    hostedUnread.read(row.id);
    void refetch();
  }, [row.id, lastAt, refetch]);
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">{t("routines.hosted.results")}</h2>
      <p className="text-muted-foreground text-xs">
        {t("routines.hosted.resultsLead")}
      </p>
      {runs.isError ? (
        <Item
          variant="muted"
          role="alert"
          className="text-muted-foreground rounded-(--pane-radius)"
        >
          {t("routines.hosted.resultsFailed")}
        </Item>
      ) : (runs.data ?? []).length === 0 ? (
        runs.isPending ? (
          <Skeleton
            aria-hidden
            className="h-12 w-full rounded-(--pane-radius)"
          />
        ) : (
          <Empty>
            <EmptyDescription>{t("routines.noRunsYet")}</EmptyDescription>
          </Empty>
        )
      ) : (
        <ItemGroup className="gap-2">
          {(runs.data ?? []).map((run) => {
            const via = deliveredKey(run.deliveredVia);
            return (
              <Item
                key={run.id}
                role="listitem"
                variant="outline"
                className="min-h-13 rounded-(--pane-radius)"
              >
                <Badge variant="secondary">
                  {t(hostedStatusKey(run.status, run.delivered))}
                </Badge>
                <time className="text-muted-foreground w-28 shrink-0 text-xs">
                  {run.at != null
                    ? new Date(run.at).toLocaleString(i18n.language, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })
                    : "—"}
                </time>
                <span className="line-clamp-3 min-w-32 flex-1 whitespace-pre-wrap">
                  {run.summary ?? ""}
                </span>
                {via != null && (
                  <span className="text-muted-foreground text-xs">
                    {t(via)}
                  </span>
                )}
              </Item>
            );
          })}
        </ItemGroup>
      )}
    </section>
  );
};
