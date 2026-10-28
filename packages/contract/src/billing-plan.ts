/**
 * The account's plan, credits and ways up, as the platform's billing plan
 * call reads them live, and the words every surface builds from it: the
 * credit wall's card in the app and the chat apps' reply. Prices, credits
 * and features come from here, never from a string in the app.
 */

/** A plan the account could be on: its price, monthly credits and what it gives. */
export interface BillingPlanTier {
  plan: string;
  planName: string;
  priceText: string;
  /** The first month's price and the monthly one, and what the first month is off (absent from older servers). */
  firstMonthPriceCents?: number;
  priceCents?: number;
  percentOff?: number;
  /** The credits a promoted first month grants; the monthly credits without a promotion (absent from older servers). */
  firstMonthCredits?: number;
  features: string[];
}

/** The account's plan, credits and ways up. */
export interface BillingPlan {
  current: {
    /** The plan's id ("free", "go", "basic", ...); absent from older servers. */
    plan?: string;
    planName: string;
    creditsRemaining: number | null;
    creditsGranted: number | null;
    freeTierExpiresAt: string | null;
  };
  plans: (BillingPlanTier & { creditsPerMonth: number; current: boolean })[];
  /** Each with the link to it, or null when it is bought in the mobile app. */
  upgrades: (BillingPlanTier & { url: string | null })[];
  topUpUrl: string | null;
  upgradeInMobileApp: boolean;
}

/** A translation function: i18next's in the app, the locale files' in main. */
export type PlanT = (
  key: string,
  values?: Record<string, string | number>
) => string;

/** Dollars in the reader's locale: "$7", "7 $", "US$ 7,50". */
export const formatUsd = (cents: number, locale: string): string =>
  new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);

/**
 * A plan's price as the wall says it: a first-month promotion leads with
 * the promo and then the monthly price, so the promo never reads as the
 * price every month. The server's own text when it sends no amounts.
 */
export function planPrice(
  t: PlanT,
  tier: BillingPlanTier,
  locale: string
): string {
  const { firstMonthPriceCents: first, priceCents: monthly } = tier;
  if (first != null && monthly != null && first < monthly)
    return t("outcome.plan.introPrice", {
      first: formatUsd(first, locale),
      monthly: formatUsd(monthly, locale),
    });
  if (monthly != null)
    return t("outcome.plan.monthlyPrice", {
      monthly: formatUsd(monthly, locale),
    });
  return tier.priceText;
}

/**
 * The credits a plan's promoted first month grants, when they are fewer than
 * its monthly credits; null otherwise: no promotion, an older server, or the
 * account's own plan, whose first month is behind it. Every line that states
 * a plan's credits reads this, so none promises the monthly figure for a first
 * month that grants less.
 */
export const firstMonthCredits = (
  tier: { firstMonthCredits?: number; current?: boolean } | null | undefined,
  monthly: number
): number | null => {
  const first = tier?.firstMonthCredits;
  return tier?.current !== true && first != null && first < monthly
    ? first
    : null;
};

/** The plan the wall offers: the first upgrade the account has. */
export const wallOffer = (
  billing: BillingPlan | null
): (BillingPlanTier & { url: string | null }) | null =>
  billing?.upgrades[0] ?? null;

/** A link the app may open: the server's, and only over https. */
export const httpsUrl = (url: string | null | undefined): string | null =>
  url != null && url.startsWith("https://") ? url : null;

/**
 * A paid plan's way on once its credits are used up, keyed off the plan the
 * server names: Basic moves up to the next plan only (it is never sold
 * credits); every other paid plan gets its top-up and the next plan up with
 * its price and features; a plan billed by Apple or Google gets the mobile
 * app, where both are bought. Null for a free account, a plan an older server
 * does not name, an unread plan, or one the server offers nothing to: the
 * surface then keeps what it did before. Every out-of-credits surface reads
 * this one rule.
 */
export interface PaidCreditsOffer {
  topUpUrl: string | null;
  next: (BillingPlanTier & { url: string | null }) | null;
  inMobileApp: boolean;
}

export const paidCreditsOffer = (
  billing: BillingPlan | null | undefined
): PaidCreditsOffer | null => {
  const plan = billing?.current.plan;
  if (billing == null || plan == null || plan === "free") return null;
  const next = billing.upgrades[0] ?? null;
  if (billing.upgradeInMobileApp)
    return {
      topUpUrl: null,
      next: next != null ? { ...next, url: null } : null,
      inMobileApp: true,
    };
  const topUpUrl = plan === "basic" ? null : httpsUrl(billing.topUpUrl);
  const nextUrl = httpsUrl(next?.url);
  if (topUpUrl == null && nextUrl == null) return null;
  return {
    topUpUrl,
    next: next != null && nextUrl != null ? { ...next, url: nextUrl } : null,
    inMobileApp: false,
  };
};

/**
 * The offer is the next plan alone (Basic's): every surface shows it the way
 * it shows the free plan's upgrade, with the same dialog and cards.
 */
export const paidUpgradeOnly = (
  offer: PaidCreditsOffer | null | undefined
): offer is PaidCreditsOffer & {
  next: BillingPlanTier & { url: string };
} =>
  offer != null &&
  !offer.inMobileApp &&
  offer.topUpUrl == null &&
  offer.next?.url != null;

/**
 * Whether the account's current plan renews its credits every month, as
 * the server says. The free plan never does: its credits are a one-time
 * grant, whatever its plan row lists.
 */
export const creditsRenewMonthly = (billing: BillingPlan | null): boolean =>
  billing?.plans.some(
    (plan) => plan.current && plan.plan !== "free" && plan.creditsPerMonth > 0
  ) === true;

/** How many of the plan's leading models a pitch names. */
const TOP_MODEL_COUNT = 4;
const TOP_MODELS_FEATURE = "top models including ";

/**
 * The plan's leading models, read from its feature line; null without one.
 * Plain string splits: the line is the server's, and a backtracking pattern
 * over it could be made slow.
 */
const planTopModels = (
  features: readonly string[],
  locale: string
): string | null => {
  for (const feature of features) {
    const line = feature.trim();
    if (!line.toLowerCase().startsWith(TOP_MODELS_FEATURE)) continue;
    const names = line
      .slice(TOP_MODELS_FEATURE.length)
      .split(",")
      .flatMap((part) => part.split(" and "))
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .slice(0, TOP_MODEL_COUNT);
    return names.length > 0
      ? new Intl.ListFormat(locale, { style: "short", type: "unit" }).format(
          names
        )
      : null;
  }
  return null;
};

const APP_PROJECTS_FEATURE = " projects a month";

/**
 * How many app projects a month the plan's apps feature line names ("...: 3
 * projects a month"); null without one. Plain string reads, as above.
 */
const planAppProjects = (features: readonly string[]): number | null => {
  for (const feature of features) {
    const line = feature.trim().toLowerCase();
    if (!line.endsWith(APP_PROJECTS_FEATURE)) continue;
    const words = line.slice(0, -APP_PROJECTS_FEATURE.length).split(/[\s:]+/);
    const count = Number(words.at(-1));
    return Number.isInteger(count) && count > 0 ? count : null;
  }
  return null;
};

/** The lines of a plan's pitch (locale keys `outcome.pitch.<line>`). */
export type PitchLine =
  | "credits"
  | "models"
  | "media"
  | "agents"
  | "connectors"
  | "apps";

export const PITCH_LINES: readonly PitchLine[] = [
  "credits",
  "models",
  "media",
  "agents",
  "connectors",
  "apps",
];

/**
 * Every line of the offered plan's pitch, in the reader's language and in
 * `order`: its monthly credits against the current plan's (after a promoted
 * first month's, when it grants fewer), the leading models
 * its feature line names, the app projects a month its apps line names, and
 * what it gives. Credits, models and projects come from billing_plan, so the
 * app names no figure or model of its own; a line it cannot read is left out
 * rather than guessed, and the apps line drops only its count.
 */
export function planPitch(
  t: PlanT,
  billing: BillingPlan | null,
  locale: string,
  order: readonly PitchLine[] = PITCH_LINES
): string[] {
  const offer = wallOffer(billing);
  const number = (value: number) =>
    new Intl.NumberFormat(locale).format(Math.round(value));
  const monthly = billing?.plans.find(
    (plan) => plan.plan === offer?.plan
  )?.creditsPerMonth;
  const current = billing?.plans.find((plan) => plan.current);
  const free =
    current?.creditsPerMonth ?? billing?.current.creditsGranted ?? null;
  // A paid plan's credits are measured against its own plan, never "free".
  const currentPlan = current?.plan ?? billing?.current.plan;
  const against =
    currentPlan != null && currentPlan !== "free"
      ? (current?.planName ?? billing?.current.planName ?? null)
      : null;
  const times =
    monthly != null && free != null && free > 0
      ? Math.round(monthly / free)
      : null;
  const first = monthly != null ? firstMonthCredits(offer, monthly) : null;
  const models = offer != null ? planTopModels(offer.features, locale) : null;
  const projects = offer != null ? planAppProjects(offer.features) : null;
  const line = (name: PitchLine): string | null => {
    switch (name) {
      case "credits":
        if (monthly == null) return null;
        const multiple = times != null && times >= 2;
        return t(
          first != null
            ? multiple
              ? against != null
                ? "outcome.pitch.introCreditsVsPlan"
                : "outcome.pitch.introCredits"
              : "outcome.pitch.introCreditsOnly"
            : multiple
              ? against != null
                ? "outcome.pitch.creditsVsPlan"
                : "outcome.pitch.credits"
              : "outcome.pitch.creditsOnly",
          {
            credits: number(monthly),
            times: times ?? 0,
            ...(first != null ? { first: number(first) } : {}),
            ...(against != null ? { plan: against } : {}),
          }
        );
      case "models":
        return models != null ? t("outcome.pitch.models", { models }) : null;
      case "apps":
        return projects != null
          ? t("outcome.pitch.appsProjects", { count: projects })
          : t("outcome.pitch.apps");
      default:
        return t(`outcome.pitch.${name}`);
    }
  };
  return order
    .map(line)
    .filter((text): text is string => text != null && text.length > 0);
}
