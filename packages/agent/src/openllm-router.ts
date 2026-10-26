/**
 * The free pool's router, as both loops drive it: which model a turn runs
 * on, and what happens when that model fails. One object holds the
 * rotation (with its file store, so a chat learns what the last one found
 * out) and the models already tried this turn, and answers every question
 * the chat loop and the bot loop ask about the pool. Neither loop touches
 * the rotation itself any more: the bot loop once picked a model and, when
 * it failed, ended the turn without recording anything, so an account with
 * its Abacus credits gone asked Abacus again on every turn and never reached
 * the Gemini key sitting next to it.
 */
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { hostCreditBalance } from "./credit-balance.js";
import {
  creditWallActive,
  freeLaneChosen,
  noteCreditsBack,
  noteCreditWall,
} from "./credit-wall.js";
import { type CooldownStore, fileCooldownStore } from "./openllm-cooldowns.js";
import { classifyFailure, type NetworkEvidence } from "./openllm-failures.js";
import {
  fileQuotaStore,
  QuotaLedger,
  type QuotaStore,
} from "./openllm-quota.js";
import { OpenLlmRotation, openLlmCandidates } from "./openllm.js";
import { listModels, type ModelChoice } from "./providers.js";
import {
  TurnChain,
  type FailureContext,
  type TurnFailure,
} from "./turn-outcome.js";

/** A model as the pool names it: provider and id. */
export interface RunningModel {
  provider: string;
  id: string;
}

/** What a failure moves the pool to: the next model, a wait for the network, or nothing. */
export type RouterStep = { nextId: string } | { network: true } | null;

/** The desktop's own models; see openllm.ts. */
const LOCAL_PROVIDER = "local";

export const OPENLLM_CONTINUATION_TYPE = "abacusai-bot:openllm-rotation";

/**
 * What the replacement model is told when it takes over a failed turn; a
 * bare "continue" invites a restart.
 */
export const OPENLLM_CONTINUATION_PROMPT =
  "The previous model's provider call failed, and you have taken over this conversation on a different model. Continue the task from the transcript above. Do not restart it or repeat work that already completed.";

export class OpenLlmRouter {
  /** Cut-off cards this session showed; see noteStreamCutCard. */
  private streamCutCards = 0;
  private readonly rotation: OpenLlmRotation;
  /**
   * Models that failed this turn. A rotation never returns to one, so a turn
   * ends in a clear failure instead of bouncing between two saturated models.
   */
  private readonly failedThisTurn = new Set<string>();

  private readonly quota: QuotaLedger;

  /** Every call this turn made and how it ended; see turn-outcome.ts. */
  readonly chain = new TurnChain();

  /** The credit refusal this router last met, for a turn the wall stops at once. */
  private lastWall: TurnFailure | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    store: CooldownStore | undefined = fileCooldownStore(),
    quotaStore: QuotaStore = fileQuotaStore()
  ) {
    this.quota = new QuotaLedger(now, quotaStore);
    this.rotation = new OpenLlmRotation(now, store, (choice) =>
      this.quota.blockedUntil(choice.provider, choice.modelId)
    );
  }

  /**
   * A reply came back, pooled or from a model picked by hand: it spent the
   * same free quota either way. A refused call spent none.
   */
  recordReply(message: unknown): void {
    const reply = message as {
      role?: unknown;
      provider?: unknown;
      model?: unknown;
      stopReason?: unknown;
      usage?: { totalTokens?: unknown };
    };
    if (
      reply?.role !== "assistant" ||
      reply.stopReason === "error" ||
      typeof reply.provider !== "string" ||
      typeof reply.model !== "string"
    )
      return;
    const tokens = reply.usage?.totalTokens;
    this.quota.record(
      reply.provider,
      reply.model,
      typeof tokens === "number" ? tokens : 0
    );
  }

  /** A new turn: the same model failing again is news again. */
  beginTurn(): void {
    this.failedThisTurn.clear();
    this.chain.begin();
  }

  /**
   * The models the pool may run now. At the credit wall that is Abacus alone
   * until the user chooses the free models: nobody is moved onto a weaker
   * model without having seen why. The free lane is the hosted free sources;
   * a model on this computer is never part of it.
   */
  private candidates(registry: ModelRegistry): ModelChoice[] {
    const all = openLlmCandidates(listModels(registry));
    const now = this.now();
    if (!creditWallActive(now)) return all;
    return freeLaneChosen(now)
      ? all.filter((choice) => choice.provider !== LOCAL_PROVIDER)
      : all.filter((choice) => choice.provider === "abacus");
  }

  /** The best model not cooling down, or none when the pool is empty. */
  pick(registry: ModelRegistry): ModelChoice | undefined {
    return this.rotation.pick(this.candidates(registry));
  }

  /** Every model the pool has is in a class the account refused: only a new source opens it. */
  poolShut(registry: ModelRegistry): boolean {
    return this.rotation.poolShut(this.candidates(registry));
  }

  /**
   * The hosted free sources the free lane would run on, in the pool's order:
   * what the wall's card names, and empty when there is nothing to go on to.
   */
  freeLaneProviders(registry: ModelRegistry): string[] {
    const providers = openLlmCandidates(listModels(registry))
      .map((choice) => choice.provider)
      .filter(
        (provider) => provider !== "abacus" && provider !== LOCAL_PROVIDER
      );
    return [...new Set(providers)];
  }

  /**
   * The credit wall stops this turn before any call: the credits are out,
   * the free lane is not chosen, and Abacus is sitting out. The refusal it
   * stands on, else null.
   */
  wallStops(registry: ModelRegistry): TurnFailure | null {
    const now = this.now();
    if (!creditWallActive(now) || freeLaneChosen(now)) return null;
    if (!this.rotation.poolShut(this.candidates(registry))) return null;
    return (
      this.lastWall ?? {
        cause: "credits_exhausted",
        provider: "abacus",
        raw: "",
      }
    );
  }

  /** What presentFailure needs to offer a way on; see FailureContext. */
  failureContext(
    registry: ModelRegistry,
    routed: boolean,
    model: { provider: string; id: string; name?: string } | undefined
  ): FailureContext {
    const provider = model?.provider;
    return {
      routed,
      ...(model != null && {
        model: {
          model: `${model.provider}/${model.id}`,
          label: model.name ?? model.id,
        },
      }),
      freeLaneProviders: this.freeLaneProviders(registry),
      onFreeLane: routed && this.onFreeLane(provider),
      abacusFreeModels: listModels(registry)
        .filter((choice) => choice.provider === "abacus" && choice.free)
        .map((choice) => ({ model: choice.id, label: choice.label })),
      abacus: !listModels(registry).some(
        (choice) => choice.provider === "abacus"
      )
        ? null
        : creditWallActive(this.now()) || hostCreditBalance()?.remaining === 0
          ? "out"
          : "credits",
    };
  }

  /**
   * A cut-off card goes out: how many this session showed before it. From
   * the second the card leads with the way off the model, without Continue.
   */
  noteStreamCutCard(): number {
    return this.streamCutCards++;
  }

  /** Whether the turn now running is on the free lane the user chose. */
  onFreeLane(provider: string | undefined): boolean {
    return provider !== "abacus" && freeLaneChosen(this.now());
  }

  /** The model answered, so it starts from a clean sheet. */
  succeeded(id: string): void {
    this.rotation.markSucceeded(id);
    const provider = id.split("/")[0];
    this.chain.answered(provider);
    // Abacus answering is the credits being back.
    if (provider === "abacus") {
      noteCreditsBack();
      this.lastWall = null;
    }
  }

  /**
   * The turn ended on a provider error from `current`. The model sits out;
   * when the account, not the model, said no (credits gone, a key's quota
   * spent), the whole class sits out with it, this chat and the next. The
   * answer is the next model to try, null when none is left this turn, or
   * `network` when the network failed: then nothing is recorded, since a
   * cooldown on disk would penalize the model for the connection.
   */
  failed(
    registry: ModelRegistry,
    failure: string,
    current: RunningModel | undefined,
    network?: NetworkEvidence
  ): RouterStep {
    const currentId =
      current != null ? `${current.provider}/${current.id}` : undefined;

    const verdict = classifyFailure(
      failure,
      current?.provider,
      this.now(),
      network
    );

    if (verdict.network === true) return { network: true };

    const cause = this.chain.failed(failure, current?.provider);
    // Free credits held until the account verifies a phone: only the user
    // lifts it, and no other model is the answer. The turn ends here and
    // nothing sits out, so the first send after verifying runs as usual.
    if (cause === "phone_verification") return null;
    if (cause === "credits_exhausted" || cause === "credits_expired") {
      noteCreditWall(this.now());
      this.lastWall = { cause, provider: current?.provider, raw: failure };
    }

    if (currentId != null) {
      this.rotation.markFailed(currentId, verdict.cooldownMs);
      this.failedThisTurn.add(currentId);
    }
    // Before picking: a sibling sharing the allowance would fail the same way.
    if (verdict.scope != null)
      this.rotation.markScopeFailed(verdict.scope, verdict.scopeMs);

    const next = this.rotation.pick(
      this.candidates(registry),
      this.failedThisTurn
    );

    return next == null ? null : { nextId: next.id };
  }

  /**
   * Every model is cooling down after saying it is busy: the one ready
   * soonest and how long until then, with it made eligible again this turn.
   * Null when the pool is shut or empty, where waiting cannot help.
   */
  soonestReady(
    registry: ModelRegistry
  ): { nextId: string; readyInMs: number } | null {
    const candidates = this.candidates(registry);
    if (this.rotation.poolShut(candidates)) return null;
    const soonest = this.rotation.soonest(candidates);
    if (soonest == null) return null;
    this.failedThisTurn.delete(soonest.id);
    return {
      nextId: soonest.id,
      readyInMs: Math.max(0, soonest.readyAt - this.now()),
    };
  }

  /**
   * Forget every cooldown: the account's credits, plan or keys changed under
   * us, and the reason a model or a provider was sidelined may not hold.
   */
  clearCooldowns(): void {
    this.rotation.clearCooldowns();
  }
}
