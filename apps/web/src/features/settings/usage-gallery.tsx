import type {
  AbacusAccountInfo,
  ModelUsageStats,
  UsageDay,
  UsageSnapshot,
} from "@abacus-ai/contract/contracts";

import { UsageView } from "./usage";

export const USAGE_GALLERY_FIXTURES = [
  "usage-free",
  "usage-paid",
  "usage-empty",
] as const;
export type UsageGalleryFixture = (typeof USAGE_GALLERY_FIXTURES)[number];

/** The gallery's "today": every fixture's window ends here. */
const GALLERY_NOW = new Date(2026, 10, 19, 15, 0, 0);

const galleryAccount = (
  plan: "free" | "basic",
  used: number
): AbacusAccountInfo => ({
  user_id: "u1",
  organization_id: "o1",
  name: "Sam Example",
  email: "sam@example.com",
  picture: null,
  organization: null,
  org_user_count: 1,
  plan: plan === "free" ? "Free" : "Basic",
  subscription_tier: plan,
  credits_used: used,
  credits_granted: plan === "free" ? 2000 : 20000,
  ...(plan === "free"
    ? { free_tier_expires_at: "2026-12-03T12:00:00Z" }
    : { plan_credits: 20000, credits_reset_at: "2026-12-03T12:00:00Z" }),
});

const totals = (requests: number, input: number, output: number, cost = 0) => ({
  requests,
  errors: 0,
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  cost,
});

const model = (
  provider: string,
  modelId: string,
  requests: number,
  tokens: number,
  cost = 0
): ModelUsageStats => ({
  ...totals(requests, Math.round(tokens * 0.9), Math.round(tokens * 0.1), cost),
  id: `${provider}/${modelId}`,
  provider,
  modelId,
  pool: false,
  billing: cost > 0 ? "billed" : "unknown",
  today: totals(0, 0, 0),
  lastUsed: GALLERY_NOW.getTime(),
});

/** Requests per day, oldest first, ending today. */
const series = (counts: readonly number[]): UsageDay[] =>
  counts.flatMap((requests, i) => {
    if (requests === 0) return [];
    const date = new Date(GALLERY_NOW);
    date.setDate(date.getDate() - (counts.length - 1) + i);
    const key = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
    return [
      { date: key, requests, errors: 0, tokens: requests * 10400, cost: 0 },
    ];
  });

const snapshotOf = (
  models: ModelUsageStats[],
  daily: UsageDay[],
  openrouter: UsageSnapshot["openrouter"] = null,
  today = 0
): UsageSnapshot => {
  const sum = (pick: (row: ModelUsageStats) => number) =>
    models.reduce((total, row) => total + pick(row), 0);
  return {
    generatedAt: GALLERY_NOW.getTime(),
    days: 30,
    totals: totals(
      sum((row) => row.requests),
      sum((row) => row.input),
      sum((row) => row.output),
      sum((row) => row.cost)
    ),
    today: totals(today, 0, 0),
    models,
    daily,
    unpriced: false,
    openrouter,
  };
};

const FIXTURES: Record<
  UsageGalleryFixture,
  { account: AbacusAccountInfo; snapshot: UsageSnapshot }
> = {
  // The account in the report: one busy day of one model, a quiet day after.
  "usage-free": {
    account: galleryAccount("free", 72.6),
    snapshot: snapshotOf(
      [model("abacus", "deepseek-ai/DeepSeek-V4.1-Flash-1017", 64, 668015)],
      series([...Array<number>(19).fill(0), 62, 2, ...Array<number>(9).fill(0)])
    ),
  },
  "usage-paid": {
    account: galleryAccount("basic", 16420),
    snapshot: snapshotOf(
      [
        model("abacus", "route-llm-code-low", 412, 5_210_000),
        model("abacus", "claude-opus-5-5", 96, 2_840_000),
        model("abacus", "gpt-6.1-sol-20261001", 51, 1_102_000),
        model("openrouter", "qwen/qwen3.5-coder", 23, 410_000, 1.84),
      ],
      series([
        4, 12, 0, 18, 22, 31, 9, 0, 0, 14, 27, 35, 19, 24, 8, 0, 11, 29, 41, 33,
        17, 0, 6, 21, 38, 26, 30, 12, 18, 7,
      ]),
      { usage: 6.42, limit: 20, isFreeTier: false },
      7
    ),
  },
  "usage-empty": {
    account: galleryAccount("free", 0),
    snapshot: snapshotOf([], []),
  },
};

export const UsageGallery = ({ fixture }: { fixture: UsageGalleryFixture }) => {
  const { account, snapshot } = FIXTURES[fixture];
  return (
    <UsageView
      snapshot={snapshot}
      failed={false}
      account={account}
      catalog={[{ id: "abacus/route-llm-code-low", label: "RouteLLM" }]}
      now={GALLERY_NOW}
      refreshing={false}
      onRefresh={() => undefined}
      onUpgrade={() => undefined}
      onTopUp={() => undefined}
    />
  );
};
