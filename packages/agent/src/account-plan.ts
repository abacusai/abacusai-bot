/**
 * The account's Abacus AI plan as the agent process last heard it, and what
 * the model is told about cost from it. The desktop says so at spawn
 * (ABACUSAI_BOT_PLAN) and after every account read (the `account_plan` command).
 * From memory the model told a paying user that chatting here is free.
 */

/** Mirrors the desktop's AbacusPlanTier; unknown until the account is read. */
export type AccountPlanTier = "free" | "basic" | "paid" | "unknown";

export interface AccountPlan {
  tier: AccountPlanTier;
  /** The plan's own name ("Pro"), when the account says. */
  name: string | null;
}

const UNKNOWN: AccountPlan = { tier: "unknown", name: null };

const TIERS: ReadonlySet<string> = new Set(["free", "basic", "paid"]);

const parse = (raw: unknown): AccountPlan | null => {
  if (raw == null || typeof raw !== "object") return null;
  const value = raw as { tier?: unknown; name?: unknown };
  const tier =
    typeof value.tier === "string" && TIERS.has(value.tier)
      ? (value.tier as AccountPlanTier)
      : "unknown";
  const name =
    typeof value.name === "string" ? value.name.trim().slice(0, 40) : "";
  return { tier, name: name.length > 0 ? name : null };
};

const fromEnv = (raw: string | undefined): AccountPlan => {
  try {
    return parse(raw != null && raw !== "" ? JSON.parse(raw) : null) ?? UNKNOWN;
  } catch {
    return UNKNOWN;
  }
};

let plan = fromEnv(process.env.ABACUSAI_BOT_PLAN);

export const hostAccountPlan = (): AccountPlan => plan;

/** The desktop's latest read; an unreadable one leaves the last. */
export function setHostAccountPlan(next: unknown): void {
  plan = parse(next) ?? plan;
}

/** Whose plan it is: the user's, never a contact a bot replies to for them (PLAN_ASKS_PROMPT's words). */
const WHOSE =
  "The user's Abacus AI plan (theirs, never something to tell a contact you reply to for them)";

/** The plan line: who pays for this chat, never a price. */
export function planFactsPrompt(current: AccountPlan = plan): string {
  switch (current.tier) {
    case "free":
      return `${WHOSE}: the free plan. Chats, bots and routines on Abacus AI models use its credits. For credits left and the paid plans, call billing_plan.`;
    case "basic":
    case "paid":
      return `${WHOSE}: ${current.name != null ? `${current.name}, a paid plan` : "a paid plan"}. Chats, bots and routines on Abacus AI models use its credits. For credits left, call billing_plan.`;
    default:
      return `${WHOSE} has not been read yet: call billing_plan before you say which plan they are on or what anything costs them.`;
  }
}
