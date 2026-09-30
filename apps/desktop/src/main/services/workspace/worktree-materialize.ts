/**
 * `git.worktrees.materialize`: create a worktree and attach it to a session
 * as one operation (legacy `materializeSessionWorktree`), idempotent per
 * `(sessionId, operationId)` (spec 04 §26.4 g). Each call without an
 * operation id creates a fresh branch and path, as the old renderer expects;
 * with one, a repeat returns the recorded result, and a concurrent repeat
 * joins the call in flight. The record is written with the attach, in one
 * persist, so a reload between the server's success and the caller's own
 * bookkeeping never creates a second worktree.
 */
import type {
  AgentSessionListItem,
  CreateWorktreeRequest,
  CreateWorktreeResult,
  MaterializeSessionWorktreeRequest,
  MaterializeSessionWorktreeResult,
  SetSessionWorktreeResult,
  WorktreeListItem,
} from "#shared/contracts";

export interface WorktreeMaterializerDeps {
  session(sessionId: string): AgentSessionListItem | null;
  recorded(
    sessionId: string
  ): { operationId: string; worktree: WorktreeListItem } | null;
  create(request: CreateWorktreeRequest): Promise<CreateWorktreeResult>;
  /** Attach (as `setSessionWorktree`), recording `operationId` with it. */
  attach(request: {
    workspaceId: string;
    sessionId: string;
    worktreeId: string;
    operationId?: string;
  }): Promise<SetSessionWorktreeResult>;
  /** Undo a worktree whose attach failed. */
  remove(workspaceId: string, worktreePath: string): Promise<void>;
}

export class WorktreeMaterializer {
  readonly #deps: WorktreeMaterializerDeps;
  readonly #inflight = new Map<
    string,
    Promise<MaterializeSessionWorktreeResult>
  >();

  constructor(deps: WorktreeMaterializerDeps) {
    this.#deps = deps;
  }

  materialize(
    request: MaterializeSessionWorktreeRequest
  ): Promise<MaterializeSessionWorktreeResult> {
    const { operationId } = request;
    if (operationId == null) return this.#run(request);

    const repeat = this.#recorded(request.sessionId, operationId);
    if (repeat != null) return Promise.resolve(repeat);
    const key = `${request.sessionId}\u0000${operationId}`;
    const inflight = this.#inflight.get(key);
    if (inflight != null) return inflight;
    const attempt = this.#run(request).finally(() => {
      this.#inflight.delete(key);
    });
    this.#inflight.set(key, attempt);
    return attempt;
  }

  #recorded(
    sessionId: string,
    operationId: string
  ): MaterializeSessionWorktreeResult | null {
    const recorded = this.#deps.recorded(sessionId);
    const session = this.#deps.session(sessionId);
    if (recorded?.operationId !== operationId || session == null) return null;
    return { success: true, worktree: recorded.worktree, session };
  }

  async #run(
    request: MaterializeSessionWorktreeRequest
  ): Promise<MaterializeSessionWorktreeResult> {
    const created = await this.#deps.create(request);
    if (!created.success || created.worktree == null) return created;

    const attached = await this.#deps.attach({
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      worktreeId: created.worktree.id,
      ...(request.operationId != null && { operationId: request.operationId }),
    });
    if (!attached.success || attached.session == null) {
      await this.#deps.remove(request.workspaceId, created.worktree.path);
      return {
        success: false,
        error: attached.error ?? "Unable to attach the new worktree.",
      };
    }
    return {
      success: true,
      worktree: created.worktree,
      session: attached.session,
    };
  }
}
