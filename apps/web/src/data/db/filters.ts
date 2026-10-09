/** Which rows the user-facing lists show (spec 01 §7.3). */
import type { SessionRow, WorkspaceRow } from "@abacus-ai/contract/contract";

/** Not a bot's chat, a routine run or a routine's editor turn. */
export const isListedSession = (session: SessionRow): boolean =>
  !session.botOwned &&
  session.editorFor == null &&
  session.routineId == null &&
  session.runTrigger !== "hosted";

/** Routine and bot folders stay out of pickers and the sidebar. */
export const isListedWorkspace = (workspace: WorkspaceRow): boolean =>
  workspace.kind !== "routine" && workspace.kind !== "bot";
