import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import { type JSX } from "react";
import { useTranslation } from "react-i18next";

import type { RoutineRunItem } from "#shared/contracts";

const TRIGGER_KEY: Record<string, string> = {
  manual: "routines.firedByManual",
  webhook: "routines.firedByWebhook",
  create: "routines.firedByCreate",
};

/**
 * Every fire of a routine, newest first, with how it went. Picking one
 * shows its transcript in the pane. Grouped so what is still running is
 * never buried under what already finished.
 */
export const RoutineRunsRail = ({
  runs,
  selectedSessionId,
  onSelect,
}: {
  runs: RoutineRunItem[];
  selectedSessionId: string | null;
  onSelect: (run: RoutineRunItem) => void;
}): JSX.Element => {
  const { t, i18n } = useTranslation();
  const groups: Array<[RoutineRunItem["outcome"], RoutineRunItem[]]> = [
    ["running", runs.filter((run) => run.outcome === "running")],
    ["completed", runs.filter((run) => run.outcome === "completed")],
    ["failed", runs.filter((run) => run.outcome === "failed")],
  ];
  const stamp = (iso: string): string =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));

  return (
    <aside
      className="border-border flex w-64 shrink-0 flex-col border-s"
      data-id="routine-runs-rail"
    >
      <div className="border-border flex items-baseline justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">{t("routines.runsTitle")}</span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {runs.length}
        </span>
      </div>
      <div className="scrollbar-autohide min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {runs.length === 0 ? (
          <p className="text-muted-foreground px-1 py-2 text-xs">
            {t("routines.runsEmpty")}
          </p>
        ) : (
          groups.map(([outcome, items]) =>
            items.length === 0 ? null : (
              <section key={outcome} className="mb-3">
                <h4 className="text-muted-foreground mb-1 px-1 text-[11px] font-medium tracking-wide uppercase">
                  {t(`routines.runOutcome.${outcome}`)}
                </h4>
                <ul className="flex flex-col gap-1">
                  {items.map((run) => {
                    const trigger =
                      run.trigger != null && TRIGGER_KEY[run.trigger] != null
                        ? ` · ${t(TRIGGER_KEY[run.trigger])}`
                        : "";
                    return (
                      <li key={run.sessionId}>
                        <button
                          type="button"
                          data-id={`routine-run-${run.sessionId}`}
                          aria-pressed={run.sessionId === selectedSessionId}
                          onClick={() => onSelect(run)}
                          className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-start text-xs transition-colors ${
                            run.sessionId === selectedSessionId
                              ? "border-primary/40 bg-accent"
                              : "border-border hover:bg-accent/50"
                          }`}
                        >
                          <RunIcon outcome={run.outcome} />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate">
                              {stamp(run.startedAt)}
                            </span>
                            <span className="text-muted-foreground">
                              {t(`routines.runOutcome.${run.outcome}`)}
                              {trigger}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )
          )
        )}
      </div>
    </aside>
  );
};

const RunIcon = ({
  outcome,
}: {
  outcome: RoutineRunItem["outcome"];
}): JSX.Element =>
  outcome === "running" ? (
    <Loader2 className="text-primary size-3.5 shrink-0 animate-spin" />
  ) : outcome === "failed" ? (
    <CircleAlert className="text-destructive size-3.5 shrink-0" />
  ) : (
    <CheckCircle2 className="text-muted-foreground size-3.5 shrink-0" />
  );
