import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Route, Wallet } from "lucide-react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";

import type {
  ModelUsageStats,
  UsageSnapshot,
  UsageTotals,
} from "#shared/contracts";

import { useAbacusAccountQuery } from "../../hooks/use-abacus-account";
import { workspaceQueryKeys } from "../../lib/query-keys";
import {
  FocusedPage,
  FocusedPageBody,
  FocusedPageLead,
} from "../layout/focused-page";
import {
  Button,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "../ui";

/**
 * Spend per model and per day, read from the agent's own session logs so it
 * works for every provider and sends nothing anywhere. OpenLLM rows show
 * errors inline: on the free tier each is almost always a routed-around limit.
 */

const fmtTokens = (value: number): string => {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;

  return String(value);
};

const fmtCost = (value: number): string => {
  if (value === 0) return "$0";

  const abs = Math.abs(value);
  // Negatives (a credit line) must not read as a tiny positive charge.
  if (abs < 0.01) return value < 0 ? ">-$0.01" : "<$0.01";

  return `${value < 0 ? "-" : ""}$${abs.toFixed(2)}`;
};

const tokensOf = (totals: UsageTotals): number =>
  totals.input + totals.output + totals.cacheRead + totals.cacheWrite;

/** One summary card: a headline number with its label and a quiet detail row. */
const StatCard = ({
  label,
  value,
  detail,
  dataId,
}: {
  label: string;
  value: string;
  detail: string;
  dataId: string;
}): JSX.Element => (
  <div
    className="border-border bg-card flex-1 rounded-lg border px-4 py-3"
    data-id={dataId}
  >
    <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
      {label}
    </div>
    <div className="text-foreground mt-1 text-xl font-semibold tabular-nums">
      {value}
    </div>
    <div className="text-muted-foreground mt-0.5 text-xs tabular-nums">
      {detail}
    </div>
  </div>
);

/**
 * The last 30 days as a strip of bars, sized by tokens moved. Deliberately
 * untooled: the tables below carry the numbers.
 */
const ActivityStrip = ({
  snapshot,
  label,
}: {
  snapshot: UsageSnapshot;
  label: string;
}): JSX.Element => {
  const byDate = new Map(snapshot.daily.map((day) => [day.date, day]));
  const max = Math.max(1, ...snapshot.daily.map((day) => day.tokens));
  const days: Array<{ date: string; tokens: number; requests: number }> = [];
  const cursor = new Date(snapshot.generatedAt);

  cursor.setDate(cursor.getDate() - (snapshot.days - 1));

  for (let i = 0; i < snapshot.days; i++) {
    const month = String(cursor.getMonth() + 1).padStart(2, "0");
    const dayOfMonth = String(cursor.getDate()).padStart(2, "0");
    const date = `${cursor.getFullYear()}-${month}-${dayOfMonth}`;
    const day = byDate.get(date);

    days.push({
      date,
      tokens: day?.tokens ?? 0,
      requests: day?.requests ?? 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  return (
    <div data-id="usage-activity-strip">
      <div className="text-muted-foreground mb-1.5 text-[0.625rem] font-semibold tracking-wide uppercase">
        {label}
      </div>
      <div className="flex h-12 items-end gap-0.75">
        {days.map((day) => (
          <div
            key={day.date}
            title={`${day.date} · ${fmtTokens(day.tokens)} tokens · ${day.requests} requests`}
            className={`min-w-0 flex-1 rounded-sm ${
              day.tokens > 0 ? "bg-primary/60" : "bg-accent"
            }`}
            style={{
              // A 3px baseline keeps quiet days visible in the strip.
              height:
                day.tokens > 0
                  ? `${Math.max(12, (day.tokens / max) * 100)}%`
                  : "3px",
            }}
          />
        ))}
      </div>
    </div>
  );
};

/**
 * One model's row. The bar is share-of-section (requests for the free pool,
 * spend for paid rows), so the busiest thing in each section reads as full.
 */
const ModelRow = ({
  model,
  share,
  errorsLabel,
}: {
  model: ModelUsageStats;
  share: number;
  errorsLabel: string;
}): JSX.Element => {
  const { t } = useTranslation();
  // A row with no published price gets no dollar column: "$0" would claim it
  // was free, which is the one thing an unknown price does not tell us.
  const cost =
    model.billing === "free"
      ? t("usage.notBilled")
      : model.billing === "unknown"
        ? t("usage.priceUnknown")
        : fmtCost(model.cost);

  return (
    <div
      className="flex flex-col gap-1 py-2"
      data-id={`usage-model-${model.id}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span
          className="text-foreground min-w-0 truncate text-xs font-medium"
          title={model.id}
        >
          {model.modelId}
          <span className="text-muted-foreground ml-2 text-[0.625rem] font-normal">
            {model.provider}
          </span>
        </span>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {t("usage.requestCount", { count: model.requests })}
          {model.errors > 0 ? (
            <span
              className="ml-2 text-amber-600 dark:text-amber-400"
              title={errorsLabel}
              data-id="usage-model-errors"
            >
              {t("usage.errorCount", { count: model.errors })}
            </span>
          ) : null}
          <span className="ml-2">{fmtTokens(tokensOf(model))} tok</span>
          <span
            className={
              model.billing === "billed"
                ? "text-foreground ml-2"
                : "text-muted-foreground ml-2"
            }
            data-id="usage-model-cost"
          >
            {cost}
          </span>
        </span>
      </div>
      <div className="bg-accent h-1.5 overflow-hidden rounded-full">
        <div
          className="bg-primary/70 h-full rounded-full"
          style={{ width: `${Math.max(2, share * 100)}%` }}
        />
      </div>
    </div>
  );
};

export const UsagePanel = (): JSX.Element => {
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  // The plan card is absent when no Abacus key is stored.
  const abacus = useAbacusAccountQuery();

  const usage = useQuery({
    queryKey: workspaceQueryKeys.usageSnapshot,
    queryFn: (): Promise<UsageSnapshot> => window.api.agent.getUsageSnapshot(),
    // The logs grow while the user works; refetch so the panel stays current.
    staleTime: 0,
    refetchOnMount: "always",
  });

  const snapshot = usage.data;
  const pool = snapshot?.models.filter((model) => model.pool) ?? [];
  const paid = snapshot?.models.filter((model) => !model.pool) ?? [];
  const poolMax = Math.max(1, ...pool.map((model) => model.requests));
  const paidMaxCost = Math.max(...paid.map((model) => model.cost), 0);

  return (
    <FocusedPage data-id="usage-panel">
      <FocusedPageBody>
        <FocusedPageLead
          description={t("usage.subtitle")}
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void usage.refetch();
                // The credits beside the snapshot: past main's cache, or a
                // press within the minute shows the same number again.
                void window.api.agent.getAbacusAccount(true).then((fresh) => {
                  if (fresh != null)
                    queryClient.setQueryData(
                      workspaceQueryKeys.abacusAccount,
                      fresh
                    );
                });
              }}
              data-id="usage-refresh"
            >
              <RefreshCw
                className={usage.isFetching ? "animate-spin" : undefined}
              />
              {t("usage.refresh")}
            </Button>
          }
        />
        {usage.isLoading ? (
          <p className="text-muted-foreground text-sm">{t("usage.loading")}</p>
        ) : usage.isError ? (
          <p className="text-destructive text-sm" data-id="usage-error">
            {t("usage.readFailed")}
          </p>
        ) : snapshot == null || snapshot.totals.requests === 0 ? (
          <p
            className="text-muted-foreground max-w-prose text-sm"
            data-id="usage-empty"
          >
            {t("usage.empty")}
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            {abacus.data != null && (
              <Item variant="outline" data-id="usage-abacus-plan">
                <ItemContent>
                  <ItemDescription>{t("usage.abacusPlan")}</ItemDescription>
                  <ItemTitle>
                    {abacus.data.plan ?? "—"}
                    {abacus.data.organization != null && (
                      <span className="text-muted-foreground ml-2 font-normal">
                        {abacus.data.organization}
                      </span>
                    )}
                  </ItemTitle>
                </ItemContent>
                {abacus.data.credits_granted != null &&
                  abacus.data.credits_granted > 0 && (
                    <ItemActions
                      className="text-sm tabular-nums"
                      data-id="usage-abacus-credits"
                    >
                      {t("usage.abacusCredits", {
                        used: Math.round(
                          abacus.data.credits_used ?? 0
                        ).toLocaleString(),
                        granted: Math.round(
                          abacus.data.credits_granted
                        ).toLocaleString(),
                      })}
                    </ItemActions>
                  )}
              </Item>
            )}
            <div className="grid gap-3 @lg:grid-cols-2 @3xl:grid-cols-3">
              <StatCard
                label={t("usage.today")}
                value={fmtCost(snapshot.today.cost)}
                detail={t("usage.cardDetail", {
                  requests: snapshot.today.requests,
                  tokens: fmtTokens(tokensOf(snapshot.today)),
                })}
                dataId="usage-card-today"
              />
              <StatCard
                label={t("usage.window", { days: snapshot.days })}
                value={fmtCost(snapshot.totals.cost)}
                detail={t("usage.cardDetail", {
                  requests: snapshot.totals.requests,
                  tokens: fmtTokens(tokensOf(snapshot.totals)),
                })}
                dataId="usage-card-window"
              />
              {snapshot.openrouter != null ? (
                <StatCard
                  label={t("usage.openrouterCard")}
                  value={
                    snapshot.openrouter.limit != null
                      ? `${fmtCost(snapshot.openrouter.usage)} / ${fmtCost(snapshot.openrouter.limit)}`
                      : fmtCost(snapshot.openrouter.usage)
                  }
                  detail={
                    snapshot.openrouter.isFreeTier
                      ? t("usage.openrouterFreeTier")
                      : t("usage.openrouterPaid")
                  }
                  dataId="usage-card-openrouter"
                />
              ) : null}
            </div>

            {snapshot.unpriced ? (
              <p
                className="text-muted-foreground text-xs"
                data-id="usage-unpriced"
              >
                {t("usage.unpricedHint")}
              </p>
            ) : null}

            <ActivityStrip snapshot={snapshot} label={t("usage.dailyTitle")} />

            {pool.length > 0 ? (
              <section data-id="usage-pool-section">
                <div className="mb-1 flex items-center gap-2">
                  <Route className="text-muted-foreground size-4" />
                  <h2 className="text-foreground text-sm font-medium">
                    {t("usage.poolTitle")}
                  </h2>
                </div>
                <p className="text-muted-foreground mb-2 text-xs">
                  {t("usage.poolSubtitle")}
                </p>
                <div className="divide-border divide-y">
                  {pool.map((model) => (
                    <ModelRow
                      key={model.id}
                      model={model}
                      share={model.requests / poolMax}
                      errorsLabel={t("usage.errorsHint")}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {paid.length > 0 ? (
              <section data-id="usage-paid-section">
                <div className="mb-1 flex items-center gap-2">
                  <Wallet className="text-muted-foreground size-4" />
                  <h2 className="text-foreground text-sm font-medium">
                    {t("usage.paidTitle")}
                  </h2>
                </div>
                <div className="divide-border divide-y">
                  {paid.map((model) => (
                    <ModelRow
                      key={model.id}
                      model={model}
                      share={
                        paidMaxCost > 0
                          ? model.cost / paidMaxCost
                          : model.requests /
                            Math.max(1, ...paid.map((m) => m.requests))
                      }
                      errorsLabel={t("usage.errorsHint")}
                    />
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        )}
      </FocusedPageBody>
    </FocusedPage>
  );
};
