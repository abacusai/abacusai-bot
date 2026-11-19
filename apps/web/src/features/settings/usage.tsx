import type {
  AbacusAccountInfo,
  ModelUsageStats,
  UsageSnapshot,
} from "@abacus-ai/contract/contracts";
import type { ModelAvailability } from "@abacus-ai/contract/models";
import { providerDisplayName } from "@abacus-ai/contract/settings";
import { useQuery } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { PageNote, AreaPage } from "#renderer/components/form-kit/page";
import { cn } from "#renderer/lib/cn";
import { sidebarAccount } from "#renderer/lib/sidebar-account";
import { openTopUp, openUpgrade, upgradeSeen } from "#renderer/lib/upgrade";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Badge } from "#renderer/ui/badge";
import { Button } from "#renderer/ui/button";

/** At this share of the credits used, the meter turns to the warning colour. */
const USAGE_METER_WARN_SHARE = 0.8;

/** Words a model id spells in lower case that its maker writes otherwise. */
const MODEL_NAME_WORDS: Record<string, string> = {
  deepseek: "DeepSeek",
  gpt: "GPT",
  glm: "GLM",
  qwen: "Qwen",
  llm: "LLM",
  oss: "OSS",
};

/**
 * A served model's name as a person reads it: the catalog's label when the
 * catalog knows the id, else the id's last part with its date stamp dropped
 * ("deepseek-ai/DeepSeek-V4.1-Flash-1017" reads "DeepSeek V4.1 Flash").
 */
export const usageModelName = (
  row: Pick<ModelUsageStats, "id" | "modelId">,
  catalog: readonly Pick<ModelAvailability, "id" | "label">[]
): string => {
  const known = catalog.find((model) => model.id === row.id);
  if (known) return known.label;
  const last = row.modelId.split("/").pop() ?? row.modelId;
  const words = last
    .replace(/:free$/iu, "")
    .split(/[-_\s]+/u)
    .filter((word) => word.length > 0);
  // A trailing 4- or 8-digit stamp is a release date, not part of the name.
  if (words.length > 1 && /^\d{4}(\d{4})?$/u.test(words.at(-1) ?? ""))
    words.pop();
  // A version split by the id's separators reads with a dot ("opus-5-5" → "Opus 5.5").
  const name = words
    .reduce<string[]>((parts, word) => {
      const previous = parts.at(-1);
      if (previous != null && /\d$/u.test(previous) && /^\d+$/u.test(word))
        parts[parts.length - 1] = `${previous}.${word}`;
      else
        parts.push(
          MODEL_NAME_WORDS[word.toLowerCase()] ??
            `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`
        );
      return parts;
    }, [])
    .join(" ");
  return name || row.modelId;
};

/** Local calendar days of the window, oldest first, today last. */
const windowDays = (days: number, now: Date): Date[] =>
  Array.from({ length: days }, (_, i) => {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (days - 1) + i);
    return date;
  });

const dateKey = (date: Date): string =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");

/** The page's own card: a plain surface with an optional header line. */
const UsageCard = ({
  id,
  title,
  aside,
  children,
}: {
  id: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) => (
  <section
    data-setting-id={id}
    aria-labelledby={`${id}-label`}
    className="bg-card border-border/60 phone:rounded-none phone:border-x-0 flex min-w-0 flex-col gap-4 rounded-(--pane-radius) border p-4"
  >
    <header className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <h2
        id={`${id}-label`}
        className="phone:text-[15px] text-[13px] font-semibold"
      >
        {title}
      </h2>
      {aside}
    </header>
    {children}
  </section>
);

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="flex min-w-0 flex-col gap-0.5">
    <span className="text-muted-foreground truncate text-xs">{label}</span>
    <span className="truncate text-lg/7 font-semibold tabular-nums">
      {value}
    </span>
  </div>
);

export interface UsageViewProps {
  snapshot: UsageSnapshot | undefined;
  failed: boolean;
  /** Null when no Abacus.AI account is signed in. */
  account: AbacusAccountInfo | null;
  catalog: readonly Pick<ModelAvailability, "id" | "label">[];
  /** The day the window ends on; the clock unless a fixture pins it. */
  now: Date;
  refreshing: boolean;
  onRefresh: () => void;
  onUpgrade: () => void;
  onTopUp: () => void;
}

/**
 * Settings → Usage: the plan's credits against their allowance, then one
 * window (the snapshot's) for every number below it, so the totals, the chart
 * and the per-model rows always add up to each other.
 */
export const UsageView = ({
  snapshot,
  failed,
  account,
  catalog,
  now,
  refreshing,
  onRefresh,
  onUpgrade,
  onTopUp,
}: UsageViewProps) => {
  const { t, i18n } = useTranslation();
  const number = (value: number) =>
    new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(
      value
    );
  const compact = (value: number) =>
    new Intl.NumberFormat(i18n.language, {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  const dollars = (value: number) =>
    new Intl.NumberFormat(i18n.language, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(value);
  const shortDate = (date: Date) =>
    new Intl.DateTimeFormat(i18n.language, {
      month: "short",
      day: "numeric",
    }).format(date);
  const billing = sidebarAccount(account).billing;
  return (
    <AreaPage
      title={t("settings.pages.usage")}
      actions={
        <Button
          size="sm"
          variant="secondary"
          disabled={refreshing}
          onClick={onRefresh}
        >
          {t("phase5.refresh")}
        </Button>
      }
    >
      {account && (
        <CreditsCard
          account={account}
          billing={billing}
          number={number}
          shortDate={shortDate}
          onUpgrade={onUpgrade}
          onTopUp={onTopUp}
        />
      )}
      {failed ? (
        <PageNote error>{t("phase5.usageFailed")}</PageNote>
      ) : !snapshot ? (
        <PageNote live>{t("phase5.usageLoading")}</PageNote>
      ) : (
        <>
          <ActivityCard
            snapshot={snapshot}
            now={now}
            number={number}
            compact={compact}
            shortDate={shortDate}
          />
          {snapshot.models.length > 0 && (
            <UsageCard
              id="usageModels"
              title={t("usage.byModel")}
              aside={
                <span className="text-muted-foreground text-xs">
                  {t("usage.window", { days: snapshot.days })}
                </span>
              }
            >
              <ModelRows
                snapshot={snapshot}
                catalog={catalog}
                number={number}
                compact={compact}
                dollars={dollars}
              />
            </UsageCard>
          )}
          {snapshot.openrouter && (
            <UsageCard id="usageKeys" title={t("usage.ownKeys")}>
              <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-[13px] font-medium">
                  {t("phase5.openrouterBrand")}
                </span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {[
                    t(
                      snapshot.openrouter.isFreeTier
                        ? "phase5.freeTier"
                        : "phase5.purchasedCredits"
                    ),
                    snapshot.openrouter.limit == null
                      ? t("usage.spent", {
                          spent: dollars(snapshot.openrouter.usage),
                        })
                      : t("usage.spentOf", {
                          spent: dollars(snapshot.openrouter.usage),
                          limit: dollars(snapshot.openrouter.limit),
                        }),
                  ].join(" · ")}
                </span>
              </div>
            </UsageCard>
          )}
        </>
      )}
    </AreaPage>
  );
};

const CreditsCard = ({
  account,
  billing,
  number,
  shortDate,
  onUpgrade,
  onTopUp,
}: {
  account: AbacusAccountInfo;
  billing: ReturnType<typeof sidebarAccount>["billing"];
  number: (value: number) => string;
  shortDate: (date: Date) => string;
  onUpgrade: () => void;
  onTopUp: () => void;
}) => {
  const { t } = useTranslation();
  const granted = account.credits_granted;
  const used = Math.max(0, account.credits_used ?? 0);
  const metered = granted != null && granted > 0;
  const share = metered ? Math.min(1, used / granted) : 0;
  const left = metered ? Math.max(0, granted - used) : 0;
  // A paid plan renews monthly; the free plan's grant is one-time and expires.
  const resetAt = account.credits_reset_at ?? null;
  const expiresAt = account.free_tier_expires_at ?? null;
  const until =
    resetAt != null && !Number.isNaN(Date.parse(resetAt))
      ? t("usage.resets", { date: shortDate(new Date(resetAt)) })
      : expiresAt != null && !Number.isNaN(Date.parse(expiresAt))
        ? t("usage.expires", { date: shortDate(new Date(expiresAt)) })
        : null;
  const warn = share >= USAGE_METER_WARN_SHARE;
  return (
    <UsageCard
      id="usageCredits"
      title={t("usage.credits")}
      aside={
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {account.plan && <Badge variant="outline">{account.plan}</Badge>}
          {billing === "upgrade" ? (
            <Button size="sm" onClick={onUpgrade}>
              {t("creditsCard.cta")}
            </Button>
          ) : billing === "manage" ? (
            <Button size="sm" variant="secondary" onClick={onTopUp}>
              {t("phase5.topUp")}
            </Button>
          ) : null}
        </div>
      }
    >
      {metered ? (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <span className="text-2xl/8 font-semibold tabular-nums">
              {number(used)}
            </span>
            <span className="text-muted-foreground text-sm tabular-nums">
              {t("usage.ofCredits", { granted: number(granted) })}
            </span>
          </p>
          <div
            role="meter"
            aria-label={t("usage.meterLabel", {
              used: number(used),
              granted: number(granted),
            })}
            aria-valuemin={0}
            aria-valuemax={granted}
            aria-valuenow={Math.min(granted, used)}
            className="bg-foreground/10 h-2 overflow-hidden rounded-full"
          >
            <div
              className={cn(
                "h-full rounded-full",
                warn ? "bg-[var(--chat-status-attention)]" : "bg-primary"
              )}
              // A sliver for any use at all, so a small spend still shows.
              style={{ width: `${used > 0 ? Math.max(1, share * 100) : 0}%` }}
            />
          </div>
          <div className="text-muted-foreground flex min-w-0 flex-wrap justify-between gap-x-3 gap-y-0.5 text-xs tabular-nums">
            <span>{t("usage.left", { left: number(left) })}</span>
            {until && <span>{until}</span>}
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">{t("usage.orgCredits")}</p>
      )}
    </UsageCard>
  );
};

const ActivityCard = ({
  snapshot,
  now,
  number,
  compact,
  shortDate,
}: {
  snapshot: UsageSnapshot;
  now: Date;
  number: (value: number) => string;
  compact: (value: number) => string;
  shortDate: (date: Date) => string;
}) => {
  const { t } = useTranslation();
  const days = windowDays(snapshot.days, now).map((date) => {
    const day = snapshot.daily.find((entry) => entry.date === dateKey(date));
    return { date, key: dateKey(date), requests: day?.requests ?? 0 };
  });
  const max = Math.max(1, ...days.map((day) => day.requests));
  const totals = snapshot.totals;
  const tokens =
    totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  const middle = days[Math.floor((days.length - 1) / 2)];
  return (
    <UsageCard
      id="usageActivity"
      title={t("usage.activity")}
      aside={
        <span className="text-muted-foreground text-xs">
          {t("usage.window", { days: snapshot.days })}
        </span>
      }
    >
      <div className="@container/usage">
        <div className="grid grid-cols-3 gap-3 @max-[220px]/usage:grid-cols-1">
          <Stat label={t("phase5.requests")} value={number(totals.requests)} />
          <Stat label={t("phase5.tokens")} value={compact(tokens)} />
          <Stat
            label={t("usage.today")}
            value={number(snapshot.today.requests)}
          />
        </div>
      </div>
      {totals.requests === 0 ? (
        <PageNote>{t("usage.empty")}</PageNote>
      ) : (
        <figure className="@container/chart flex min-w-0 flex-col gap-1.5">
          <div className="text-muted-foreground flex items-center gap-2 text-[11px] tabular-nums">
            <span className="border-border flex-1 border-t border-dashed" />
            <span>{t("usage.peak", { value: number(max) })}</span>
          </div>
          <div
            aria-hidden
            className="flex h-28 items-end gap-[2px]"
            data-slot="usage-chart"
          >
            {days.map((day, i) => (
              <div
                key={day.key}
                title={t("usage.dayRequests", {
                  date: shortDate(day.date),
                  count: day.requests,
                  value: number(day.requests),
                })}
                className="group/day flex h-full min-w-0 flex-1 items-end"
              >
                <div
                  className={cn(
                    "w-full rounded-t-[3px] transition-opacity",
                    day.requests > 0
                      ? i === days.length - 1
                        ? "bg-primary"
                        : "bg-primary/75 group-hover/day:bg-primary"
                      : "bg-border"
                  )}
                  style={{
                    height:
                      day.requests > 0
                        ? `max(3px, ${(day.requests / max) * 100}%)`
                        : "2px",
                  }}
                />
              </div>
            ))}
          </div>
          <figcaption className="text-muted-foreground flex justify-between gap-2 text-[11px] whitespace-nowrap tabular-nums">
            <span className="min-w-0 truncate">
              {days[0] && shortDate(days[0].date)}
            </span>
            <span className="min-w-0 truncate @max-[320px]/chart:hidden">
              {middle && shortDate(middle.date)}
            </span>
            <span className="min-w-0 truncate">{t("usage.today")}</span>
          </figcaption>
          <table className="sr-only">
            <caption>{t("usage.activity")}</caption>
            <thead>
              <tr>
                <th>{t("phase5.date")}</th>
                <th>{t("phase5.requests")}</th>
              </tr>
            </thead>
            <tbody>
              {days
                .filter((day) => day.requests > 0)
                .map((day) => (
                  <tr key={day.key}>
                    <td>{shortDate(day.date)}</td>
                    <td>{day.requests}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </figure>
      )}
    </UsageCard>
  );
};

const ModelRows = ({
  snapshot,
  catalog,
  number,
  compact,
  dollars,
}: {
  snapshot: UsageSnapshot;
  catalog: readonly Pick<ModelAvailability, "id" | "label">[];
  number: (value: number) => string;
  compact: (value: number) => string;
  dollars: (value: number) => string;
}) => {
  const { t } = useTranslation();
  // Most used first: the snapshot orders by spend, which Abacus credits do not carry.
  const rows = [...snapshot.models].sort((a, b) => b.requests - a.requests);
  const top = Math.max(1, rows[0]?.requests ?? 0);
  return (
    <ul className="flex min-w-0 flex-col gap-3.5">
      {rows.map((row) => {
        const tokens = row.input + row.output + row.cacheRead + row.cacheWrite;
        // Abacus.AI turns are paid in credits; a dollar figure only means
        // something on the user's own provider keys.
        const cost =
          row.provider !== "abacus" && row.billing === "billed" && row.cost > 0
            ? dollars(row.cost)
            : null;
        return (
          <li
            key={row.id}
            data-setting-id={`usage-${row.id}`}
            className="flex min-w-0 flex-col gap-1.5"
          >
            <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <div className="flex min-w-0 items-baseline gap-2">
                <span
                  className="truncate text-[13px] font-medium"
                  title={row.id}
                >
                  {usageModelName(row, catalog)}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {providerDisplayName(row.provider)}
                </span>
              </div>
              <span className="text-muted-foreground text-xs tabular-nums">
                {[
                  t("usage.requests", {
                    count: row.requests,
                    value: number(row.requests),
                  }),
                  t("usage.tokens", { tokens: compact(tokens) }),
                  ...(cost ? [cost] : []),
                ].join(" · ")}
              </span>
            </div>
            <div
              aria-hidden
              className="bg-foreground/8 h-1 overflow-hidden rounded-full"
            >
              <div
                className="bg-primary/75 h-full rounded-full"
                style={{ width: `${(row.requests / top) * 100}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
};

export const UsagePage = () => {
  const { transport } = useAppContext();
  const query = useQuery({
    ...transport.orpc.account.usage.queryOptions({ input: {} }),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const models = useQuery(
    transport.orpc.models.list.queryOptions({ input: {} })
  );
  const account = useAccount();
  // The view also renders without the app (gallery, tests), so the shown step is reported here.
  const offersUpgrade =
    account.data != null && sidebarAccount(account.data).billing === "upgrade";
  useEffect(() => {
    if (offersUpgrade) upgradeSeen(transport.client, "settings");
  }, [offersUpgrade, transport.client]);
  return (
    <UsageView
      snapshot={query.data}
      failed={query.isError}
      account={account.data ?? null}
      catalog={models.data ?? []}
      now={new Date()}
      refreshing={query.isFetching || account.isFetching}
      onRefresh={() => {
        void query.refetch();
        void account.refetch();
      }}
      onUpgrade={() => void openUpgrade(transport.client, "settings")}
      onTopUp={() => void openTopUp(transport.client)}
    />
  );
};
