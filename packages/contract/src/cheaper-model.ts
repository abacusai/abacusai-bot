/**
 * The paid credit cards' "make your credits last" option: one tap moves the
 * chat the card names off a top model and back onto the plan's own low-cost
 * router, from its next message.
 *
 * It moves the chat in place, unlike the way up (continue-chat.ts opens a new chat from a
 * summary). Going up, a fresh chat lets the stronger model start clean;
 * going down there is nothing to restart, and a new chat would spend a
 * summary call and lose the user's place at the moment they are trying to
 * save credits. The chat keeps its history, and only this chat moves: the
 * app's default and other chats keep theirs.
 */
import {
  ABACUS_CODE_ROUTER_LOW_ID,
  isCostlyModel,
  type ModelTier,
} from "./models";
import { modelIdentity, TOP_MODEL_FAMILIES } from "./retry-offer";

interface CheaperCatalogRow {
  id: string;
  label: string;
  tier: ModelTier;
  configured: boolean;
  access?: string;
  recommended?: boolean;
}

const TOP_FAMILIES: readonly string[] = Object.values(TOP_MODEL_FAMILIES);

/**
 * A model that spends credits fast: priced with the strong models, an Opus or
 * Sonnet by its catalog id, or one of the plan's top models (`planIds`).
 */
export const isTopModel = (
  model: Pick<CheaperCatalogRow, "id" | "tier">,
  planIds: readonly string[] = []
): boolean =>
  isCostlyModel(model) ||
  TOP_FAMILIES.includes(modelIdentity(model.id).family) ||
  planIds.includes(model.id);

const runnable = (model: CheaperCatalogRow): boolean =>
  model.configured && model.access !== "locked";

/**
 * The plan's own low-cost model: the catalog's recommended row (each plan's
 * router), else the low code router, when it runs now and is not itself a
 * top model.
 */
export const planDefaultModel = <T extends CheaperCatalogRow>(
  catalog: readonly T[],
  planIds: readonly string[] = []
): T | null =>
  [
    catalog.find((model) => model.recommended === true),
    catalog.find((model) => model.id === ABACUS_CODE_ROUTER_LOW_ID),
  ].find(
    (model): model is T =>
      model != null && runnable(model) && !isTopModel(model, planIds)
  ) ?? null;

/**
 * What the card offers: the chat's current top model and the plan's default
 * to move it to. Null unless the plan is paid, the chat is a listed one (a
 * bot's chats and routine runs keep their model), its model is a top model,
 * and the plan's default runs and differs.
 */
export const cheaperModelOffer = <T extends CheaperCatalogRow>(input: {
  plan: "free" | "paid" | null;
  /** The chat's model as it runs: its pin, else the app's default, resolved. */
  modelId: string | null;
  /** A user's own chat in a user's folder: not a bot's, a routine's or an editor's. */
  listed: boolean;
  catalog: readonly T[];
  planIds?: readonly string[];
}): { current: T; target: T } | null => {
  if (input.plan !== "paid" || !input.listed || input.modelId == null)
    return null;
  const planIds = input.planIds ?? [];
  const current = input.catalog.find((model) => model.id === input.modelId);
  if (current == null || !isTopModel(current, planIds)) return null;
  const target = planDefaultModel(input.catalog, planIds);
  return target != null && target.id !== current.id
    ? { current, target }
    : null;
};
