/**
 * The DB tables' procedures. Their feeds (snapshot, change batches, mutation
 * echoes) are sub-slice B; until it lands every one answers `UNAVAILABLE`,
 * which the renderer's queries treat as "retry later".
 */
import { unavailable } from "../errors";
import { impl } from "./impl";

const notYet = (): never => {
  throw unavailable("The DB tables land in sub-slice B");
};

export const dbRouter = impl.db.router({
  sessions: {
    snapshot: impl.db.sessions.snapshot.handler(notYet),
    changes: impl.db.sessions.changes.handler(notYet),
    insert: impl.db.sessions.insert.handler(notYet),
    update: impl.db.sessions.update.handler(notYet),
    delete: impl.db.sessions.delete.handler(notYet),
  },
  bots: {
    snapshot: impl.db.bots.snapshot.handler(notYet),
    changes: impl.db.bots.changes.handler(notYet),
    insert: impl.db.bots.insert.handler(notYet),
    update: impl.db.bots.update.handler(notYet),
    delete: impl.db.bots.delete.handler(notYet),
  },
  routines: {
    snapshot: impl.db.routines.snapshot.handler(notYet),
    changes: impl.db.routines.changes.handler(notYet),
    insert: impl.db.routines.insert.handler(notYet),
    update: impl.db.routines.update.handler(notYet),
    delete: impl.db.routines.delete.handler(notYet),
  },
  routineRuns: {
    snapshot: impl.db.routineRuns.snapshot.handler(notYet),
    changes: impl.db.routineRuns.changes.handler(notYet),
  },
  artifacts: {
    snapshot: impl.db.artifacts.snapshot.handler(notYet),
    changes: impl.db.artifacts.changes.handler(notYet),
  },
  memories: {
    snapshot: impl.db.memories.snapshot.handler(notYet),
    changes: impl.db.memories.changes.handler(notYet),
    delete: impl.db.memories.delete.handler(notYet),
  },
  workspaces: {
    snapshot: impl.db.workspaces.snapshot.handler(notYet),
    changes: impl.db.workspaces.changes.handler(notYet),
    update: impl.db.workspaces.update.handler(notYet),
    delete: impl.db.workspaces.delete.handler(notYet),
  },
  gitState: {
    snapshot: impl.db.gitState.snapshot.handler(notYet),
    changes: impl.db.gitState.changes.handler(notYet),
  },
  prefs: {
    snapshot: impl.db.prefs.snapshot.handler(notYet),
    changes: impl.db.prefs.changes.handler(notYet),
    update: impl.db.prefs.update.handler(notYet),
  },
});
