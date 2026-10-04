/**
 * Checkouts (spec 04 §26.4 a, b): a session works in its worktree when it
 * has one, else in its workspace's primary checkout. Every checkout-aware
 * procedure names one with a `CheckoutRef`, and main resolves it; the
 * renderer never sends a path to operate in.
 */
import * as v from "valibot";

import { SessionId, WorkspaceId } from "./ids";

export const CheckoutRefSchema = v.object({
  workspaceId: WorkspaceId,
  /** The session whose worktree (if any) is meant. */
  sessionId: v.optional(SessionId),
});

export type CheckoutRef = v.InferOutput<typeof CheckoutRefSchema>;

/** `workspaceId + ":" + (worktreeId ?? "primary")`: the `gitState` row key. */
export type CheckoutKey = string;

export const PRIMARY_CHECKOUT = "primary";

export const checkoutKey = (
  workspaceId: string,
  worktreeId: string | null | undefined
): CheckoutKey => `${workspaceId}:${worktreeId ?? PRIMARY_CHECKOUT}`;

/** `git.checkoutStatus`: the effective path of a checkout, and whether it is there. */
export interface CheckoutStatus {
  kind: "primary" | "worktree";
  path: string;
  /** The effective path (the worktree's, for a worktree) is a directory. */
  exists: boolean;
  /** The workspace's own folder is a directory. */
  workspaceExists: boolean;
}

/**
 * `git.diff`: a patch only when git reports one in the requested scope; the
 * whole-file view only for a path git reports as untracked (§26.4 h).
 */
export interface GitDiffResult {
  kind: "patch" | "untracked" | "binary" | "none";
  patch?: string;
}

/**
 * A change to discard: its checkout-relative path with `/` separators, as
 * git spells it under the checkout (a backslash is a separator only on
 * Windows).
 */
export const GitDiscardEntrySchema = v.object({
  path: v.pipe(v.string(), v.nonEmpty()),
  /** A rename's source, from the change item's `origPath`. */
  origPath: v.optional(v.pipe(v.string(), v.nonEmpty())),
});

export type GitDiscardEntry = v.InferOutput<typeof GitDiscardEntrySchema>;

/**
 * Why a discard entry failed. Every reason but `partial` means nothing of
 * that entry changed.
 * - `not-changed`: git reports no change at that exact path (a directory,
 *   another spelling, a path through a symlink, or an `origPath` that is not
 *   git's rename source).
 * - `occupied`: a rename's source holds content other than HEAD's, which
 *   restoring it would destroy.
 * - `blocked`: a pending migration may still restore the file.
 * - `trash`: the file could not go to the Trash, so its index entry stayed.
 * - `git`: a git step failed before anything changed.
 * - `partial`: a later step failed after an earlier one changed something
 *   (the new file is in the Trash but still staged; a rename's destination
 *   is gone but its source is not back).
 */
export type GitDiscardFailureReason =
  | "not-changed"
  | "occupied"
  | "blocked"
  | "trash"
  | "git"
  | "partial";

/** Per entry: put back as in HEAD, or failed (see the reasons). */
export interface GitDiscardResult {
  discarded: string[];
  failed: Array<{
    path: string;
    reason: GitDiscardFailureReason;
    detail: string;
  }>;
}
