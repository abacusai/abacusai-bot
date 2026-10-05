import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import type {
  CreateWorktreeResult,
  GetGitBranchesResult,
  GetGitCurrentBranchResult,
  ListWorktreesResult,
  MaterializeSessionWorktreeResult,
  PrInfo,
  SetSessionWorktreeResult,
} from "../contracts";
import { mutation, query, subscription } from "./base";
import {
  CheckoutRefSchema,
  GitDiscardEntrySchema,
  type CheckoutKey,
  type CheckoutStatus,
  type GitDiffResult,
  type GitDiscardResult,
} from "./checkout";
import { SessionId, WorkspaceId } from "./ids";

export const ListWorktreesRequestSchema = v.object({
  workspaceId: WorkspaceId,
});

export const CreateWorktreeRequestSchema = v.object({
  workspaceId: WorkspaceId,
  baseRef: v.pipe(v.string(), v.nonEmpty()),
  name: v.optional(v.string()),
});

export const SetSessionWorktreeRequestSchema = v.object({
  workspaceId: WorkspaceId,
  sessionId: SessionId,
  worktreeId: v.nullable(v.string()),
});

export const MaterializeSessionWorktreeRequestSchema = v.object({
  workspaceId: WorkspaceId,
  baseRef: v.pipe(v.string(), v.nonEmpty()),
  name: v.optional(v.string()),
  sessionId: SessionId,
  /**
   * The caller's id for this attempt (spec 04 §26.4 g): a repeat with the
   * same `(sessionId, operationId)` returns the recorded result and creates
   * no second branch or path. The session row shows it as
   * `worktreeOperationId`.
   */
  operationId: v.pipe(v.string(), v.nonEmpty(), v.maxLength(128)),
});

export const WorkspaceGitContextSchema = v.object({
  workspaceId: WorkspaceId,
  sessionId: v.optional(SessionId),
});

const BranchInput = v.object({
  branchName: v.pipe(v.string(), v.nonEmpty()),
  context: v.optional(WorkspaceGitContextSchema),
});

/** `git.watch`'s one yield: the row it keeps computed in `db.gitState`. */
export type GitWatchEvent = { type: "watching"; checkoutKey: CheckoutKey };

export const git = {
  worktrees: {
    list: query
      .input(ListWorktreesRequestSchema)
      .output(type<ListWorktreesResult>()),
    create: mutation
      .input(CreateWorktreeRequestSchema)
      .output(type<CreateWorktreeResult>()),
    setForSession: mutation
      .input(SetSessionWorktreeRequestSchema)
      .output(type<SetSessionWorktreeResult>()),
    materialize: mutation
      .input(MaterializeSessionWorktreeRequestSchema)
      .output(type<MaterializeSessionWorktreeResult>()),
  },
  branches: query
    .input(v.optional(WorkspaceGitContextSchema))
    .output(type<GetGitBranchesResult>()),
  currentBranch: query
    .input(v.optional(WorkspaceGitContextSchema))
    .output(type<GetGitCurrentBranchResult>()),
  prInfo: query
    .input(v.optional(WorkspaceGitContextSchema))
    .output(type<PrInfo | null>()),
  /** `SwitchGitBranchResult` unwrapped. */
  switchBranch: mutation
    .input(BranchInput)
    .output(type<{ currentBranch: string | null }>()),
  /** `CreateGitBranchResult` unwrapped. */
  createBranch: mutation
    .input(BranchInput)
    .output(type<{ currentBranch: string | null }>()),
  /**
   * A file's diff in `checkout` (the legacy active workspace without it);
   * covers the retired `getGitDiffForPath`. `untracked` only for a path git
   * reports as untracked; a tracked path with no change in `scope` is
   * `none` (spec 04 §26.4 h).
   */
  diff: query
    .input(
      v.object({
        filePath: v.pipe(v.string(), v.nonEmpty()),
        scope: v.optional(v.picklist(["staged", "unstaged"])),
        checkout: v.optional(CheckoutRefSchema),
      })
    )
    .output(type<GitDiffResult>()),
  /**
   * Puts each entry back as it is in HEAD, in the checkout (§26.4 c). Only
   * a change git reports at exactly that checkout-relative path is touched,
   * and git's status decides the action. A path absent from HEAD (untracked,
   * a staged addition, a rename's destination) goes to the OS Trash before
   * its index entry is removed; a rename also restores its `origPath`
   * (refused as `occupied` when new content sits there). A failed entry
   * changes nothing of its own, except `partial` (see
   * `GitDiscardFailureReason`).
   */
  discard: mutation
    .input(
      v.object({
        checkout: CheckoutRefSchema,
        entries: v.pipe(v.array(GitDiscardEntrySchema), v.minLength(1)),
      })
    )
    .output(type<GitDiscardResult>()),
  /** The checkout's effective path and whether it (and its workspace) exist. */
  checkoutStatus: query
    .input(v.object({ checkout: CheckoutRefSchema }))
    .output(type<CheckoutStatus>()),
  /**
   * While open, main computes the checkout's `db.gitState` row (keyed by
   * its `checkoutKey`) and its `files.events tree-root-changed`. Yields once,
   * then stays open until the caller closes it.
   */
  watch: subscription
    .input(v.object({ checkout: CheckoutRefSchema }))
    .output(eventIterator(type<GitWatchEvent>())),
};
