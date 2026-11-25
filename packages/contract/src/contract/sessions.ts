import { type } from "@orpc/contract";
import * as v from "valibot";

import type { SessionTurnStateSnapshot } from "../contracts";
import { mutation, query } from "./base";
import { SessionId, WorkspaceId } from "./ids";

const SessionFolderInput = v.object({
  sessionId: SessionId,
  path: v.pipe(v.string(), v.nonEmpty()),
});

/**
 * Session rows, their creation, renames, model pins and removal are the
 * `db.sessions` table. What remains here is the turn state of a session whose
 * row is not open, and the folders a chat works in beyond its own (the row's
 * `folders`, which only main writes, after checking the folder).
 */
export const sessions = {
  turnState: query
    .input(v.object({ workspaceId: WorkspaceId, sessionId: SessionId }))
    .output(type<SessionTurnStateSnapshot>()),
  folders: {
    /** FORBIDDEN `folder-not-allowed` for home, a root or a system folder; BAD_REQUEST when not a folder. */
    add: mutation
      .input(SessionFolderInput)
      .output(type<{ folders: string[] }>()),
    remove: mutation
      .input(SessionFolderInput)
      .output(type<{ folders: string[] }>()),
  },
};
