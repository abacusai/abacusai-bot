import { type } from "@orpc/contract";
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
import { mutation, query } from "./base";
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
});

export const WorkspaceGitContextSchema = v.object({
  workspaceId: WorkspaceId,
  sessionId: v.optional(SessionId),
});

const BranchInput = v.object({
  branchName: v.pipe(v.string(), v.nonEmpty()),
  context: v.optional(WorkspaceGitContextSchema),
});

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
  /** A file's diff in the active workspace; covers the retired `getGitDiffForPath`. */
  diff: query
    .input(
      v.object({
        filePath: v.pipe(v.string(), v.nonEmpty()),
        scope: v.optional(v.picklist(["staged", "unstaged"])),
      })
    )
    .output(type<string>()),
};
