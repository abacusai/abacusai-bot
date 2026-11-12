import { type ModelAvailability, OPENLLM_ID } from "@abacus-ai/contract/models";
import { providerDisplayName } from "@abacus-ai/contract/settings";

/**
 * The agent's action on a turn on a model Abacus does not serve (the user's
 * own key, another provider's free model, a local server; never Abacus's,
 * never the router's) that did not finish: the chat says so and offers Abacus
 * in its place. Only ever on a terminal error.
 */
export const OWN_KEY_UNAVAILABLE_ACTION = "own-key-unavailable";

/**
 * The key's balance is spent, its rate limit hit, or its provider silent; the
 * model is gone, sent no reply, or failed otherwise. `cutoff` is the cut-off
 * card's Upgrade: Google cut the reply off, and the plan's dialog resumes the
 * turn on an Abacus model.
 */
export type OwnKeyCause =
  | "credit"
  | "rate_limit"
  | "down"
  | "network"
  | "gone"
  | "no_reply"
  | "failed"
  | "cutoff";

export interface OwnKeyFailure {
  provider: string;
  cause: OwnKeyCause;
  /** The picked model's name, and whether it is the provider's free one. */
  label?: string;
  free?: boolean;
}

// `cutoff` never arrives on an action: only the cut-off card asks with it.
const CAUSES = new Set<string>([
  "credit",
  "rate_limit",
  "down",
  "network",
  "gone",
  "no_reply",
  "failed",
]);

/** The own-key failure off a failed turn's actions; or null. */
export const ownKeyFailure = (
  actions:
    | ReadonlyArray<{
        type?: string;
        provider?: string;
        cause?: string;
        label?: string;
        free?: boolean;
      }>
    | undefined
): OwnKeyFailure | null => {
  const action = actions?.find(
    (entry) => entry.type === OWN_KEY_UNAVAILABLE_ACTION
  );
  if (action?.provider == null || action.cause == null) return null;
  return CAUSES.has(action.cause)
    ? {
        provider: action.provider,
        cause: action.cause as OwnKeyCause,
        ...(action.label != null && { label: action.label }),
        ...(action.free === true && { free: true }),
      }
    : null;
};

/** The line that says what happened to the key, by cause. */
export const ownKeyHeadlineKey = (cause: OwnKeyCause): string =>
  ({
    credit: "ownKey.outOfCredit",
    rate_limit: "ownKey.rateLimited",
    cutoff: "outcome.cutoff.title",
    gone: "ownKey.gone",
    no_reply: "ownKey.noReply",
    failed: "ownKey.failed",
    down: "ownKey.notResponding",
    network: "ownKey.notResponding",
  })[cause];

/** The local server provider: it has no key and no company. */
const LOCAL_PROVIDER = "local";

/** The model and who serves it, as the lines name them. */
const ownKeyValues = (
  failure: { provider?: string; label?: string },
  t: (key: string) => string
): { provider: string; model: string } => {
  const provider =
    failure.provider === LOCAL_PROVIDER
      ? t("ownKey.localServer")
      : providerDisplayName(failure.provider ?? "");
  return { provider, model: failure.label ?? provider };
};

/** The agent moved the message to RouteLLM - Open: its notice's line. */
export const MOVED_TO_ABACUS_ACTION = "moved-to-abacus";

export const ownKeyMovedLine = (
  action: { provider?: string; label?: string; target?: string },
  t: (key: string, values?: Record<string, string>) => string
): string =>
  t("ownKey.moved", {
    ...ownKeyValues(action, t),
    target: action.target ?? OPENLLM_NAME,
  });

/** RouteLLM - Open by name, for a notice from an agent that named no target. */
const OPENLLM_NAME = "RouteLLM - Open";

/**
 * What a card or the dialog says about a failed model off Abacus: what
 * happened, naming the model and its provider (or the user's local server),
 * and why such a model fails. Plain words, no blame.
 */
export const ownKeyWords = (
  failure: Pick<OwnKeyFailure, "provider" | "cause" | "label" | "free">,
  t: (key: string, values?: Record<string, string>) => string
): { title: string; why: string } => {
  const local = failure.provider === LOCAL_PROVIDER;
  const values = ownKeyValues(failure, t);
  const title = t(ownKeyHeadlineKey(failure.cause), values);
  return {
    // "your local model server ..." can lead the line; a model id never is
    // recased.
    title:
      local && title.startsWith(values.provider)
        ? title.charAt(0).toLocaleUpperCase() + title.slice(1)
        : title,
    why: t(
      local
        ? "ownKey.whyLocal"
        : failure.free === true
          ? "ownKey.whyFree"
          : "ownKey.whyKey",
      values
    ),
  };
};

/**
 * The model the waiting message sends on once the plan is active: the plan's
 * own recommendation (RouteLLM - Open on Basic, the code router on Pro),
 * else the catalog's Abacus default, else RouteLLM - Open, which the plan's
 * pin rules move to its router where it has none.
 */
export const ownKeyResumeModel = (
  catalog: readonly ModelAvailability[]
): string => {
  const runnable = catalog.filter((model) => model.configured);
  return (
    runnable.find((model) => model.recommended === true)?.id ??
    runnable.find(
      (model) => model.provider === "abacus" && model.tier === "default"
    )?.id ??
    OPENLLM_ID
  );
};
