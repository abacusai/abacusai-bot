import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useAppContext } from "#renderer/lib/use-app-context";

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
    <section>
      <h2 className="mb-2 text-sm font-semibold">
        {t("routines.hosted.results")}
      </h2>
      <p className="text-muted-foreground mb-2 text-xs">
        {t("routines.hosted.resultsLead")}
      </p>
      {runs.isError ? (
        <p className="text-muted-foreground text-xs">
          {t("routines.hosted.resultsFailed")}
        </p>
      ) : (runs.data ?? []).length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {runs.isPending ? "" : t("routines.noRunsYet")}
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {(runs.data ?? []).map((run) => {
            const via = deliveredKey(run.deliveredVia);
            return (
              <div
                key={run.id}
                className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2 text-[13px]"
              >
                <span className="w-28 shrink-0">
                  {t(hostedStatusKey(run.status, run.delivered))}
                </span>
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
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};
