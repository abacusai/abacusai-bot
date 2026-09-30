import { type } from "@orpc/contract";
import * as v from "valibot";

import type { SessionTurnStateSnapshot } from "../contracts";
import { query } from "./base";
import { SessionId, WorkspaceId } from "./ids";

/**
 * Session rows, their creation, renames, model pins and removal are the
 * `db.sessions` table. What remains here is the turn state of a session whose
 * row is not open.
 */
export const sessions = {
  turnState: query
    .input(v.object({ workspaceId: WorkspaceId, sessionId: SessionId }))
    .output(type<SessionTurnStateSnapshot>()),
};
