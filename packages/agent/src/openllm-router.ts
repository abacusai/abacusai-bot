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

import { type CooldownStore, fileCooldownStore } from "./openllm-cooldowns.js";
import {
  OpenLlmRotation,
  accountWideFailure,
  openLlmCandidates,
} from "./openllm.js";
import { listModels, type ModelChoice } from "./providers.js";

/** A model as the pool names it: provider and id. */
export interface RunningModel {
  provider: string;
  id: string;
}

export const OPENLLM_CONTINUATION_TYPE = "abacusai-bot:openllm-rotation";

/**
 * What the replacement model is told when it takes over a failed turn; a
 * bare "continue" invites a restart.
 */
export const OPENLLM_CONTINUATION_PROMPT =
  "The previous model's provider call failed, and you have taken over this conversation on a different model. Continue the task from the transcript above. Do not restart it or repeat work that already completed.";

export class OpenLlmRouter {
  private readonly rotation: OpenLlmRotation;
  /**
   * Models that failed this turn. A rotation never returns to one, so a turn
   * ends in a clear failure instead of bouncing between two saturated models.
   */
  private readonly failedThisTurn = new Set<string>();

  constructor(
    now: () => number = Date.now,
    store: CooldownStore | undefined = fileCooldownStore()
  ) {
    this.rotation = new OpenLlmRotation(now, store);
  }

  /** A new turn: the same model failing again is news again. */
  beginTurn(): void {
    this.failedThisTurn.clear();
  }

  /** The best model not cooling down, or none when the pool is empty. */
  pick(registry: ModelRegistry): ModelChoice | undefined {
    return this.rotation.pick(openLlmCandidates(listModels(registry)));
  }

  /** Every model the pool has is in a class the account refused: only a new source opens it. */
  poolShut(registry: ModelRegistry): boolean {
    return this.rotation.poolShut(openLlmCandidates(listModels(registry)));
  }

  /** The model answered, so it starts from a clean sheet. */
  succeeded(id: string): void {
    this.rotation.markSucceeded(id);
  }

  /**
   * The turn ended on a provider error from `current`. The model sits out;
   * when the account, not the model, said no (credits gone, a key's quota
   * spent), the whole class sits out with it, this chat and the next. The
   * answer is the next model to try, or null when none is left this turn.
   */
  failed(
    registry: ModelRegistry,
    failure: string,
    current: RunningModel | undefined
  ): { nextId: string } | null {
    const currentId =
      current != null ? `${current.provider}/${current.id}` : undefined;

    if (currentId != null) {
      this.rotation.markFailed(currentId);
      this.failedThisTurn.add(currentId);
    }
    // Before picking: a sibling sharing the allowance would fail the same way.
    const scope = accountWideFailure(failure, current?.provider);

    if (scope != null) this.rotation.markScopeFailed(scope);

    const next = this.rotation.pick(
      openLlmCandidates(listModels(registry)),
      this.failedThisTurn
    );

    return next == null ? null : { nextId: next.id };
  }

  /**
   * Forget every cooldown: the account's credits, plan or keys changed under
   * us, and the reason a model or a provider was sidelined may not hold.
   */
  clearCooldowns(): void {
    this.rotation.clearCooldowns();
  }
}
