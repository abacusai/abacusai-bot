import { type } from "@orpc/contract";
import * as v from "valibot";

import type { WorkspacePathStatus } from "../contracts";
import { mutation, query } from "./base";
import { NoInput, WorkspaceId } from "./ids";

/**
 * Workspace commands. The list itself is the `db.workspaces` table; renames
 * and removals go through its mutations.
 */
export const workspaces = {
  /** `AddWorkspaceResult` unwrapped: a failure is an error, not a flag. */
  add: mutation
    .input(
      v.object({
        path: v.pipe(v.string(), v.nonEmpty()),
        isRemote: v.optional(v.boolean()),
      })
    )
    .output(type<{ workspaceId: string | null }>()),
  /** The "Auto workspace", added and selected on first ask. */
  ensureSessionHome: mutation
    .input(NoInput)
    .output(type<{ workspaceId: string | null }>()),
  sessionHomePath: query.input(NoInput).output(type<{ path: string }>()),
  /** The legacy main-side active workspace; new routes carry `workspaceId`. */
  switch: mutation
    .input(v.object({ workspaceId: WorkspaceId }))
    .output(type<void>()),
  checkPath: query
    .input(v.object({ workspaceId: WorkspaceId }))
    .output(type<WorkspacePathStatus>()),
  relocate: mutation
    .input(
      v.object({
        workspaceId: WorkspaceId,
        newPath: v.pipe(v.string(), v.nonEmpty()),
      })
    )
    .output(type<void>()),
};
