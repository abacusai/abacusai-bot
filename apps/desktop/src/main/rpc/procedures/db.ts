/**
 * The DB tables' procedures (spec 00 B.1, B.4). Reads come from each table's
 * feed. A mutation calls the same ServiceHost method the legacy IPC handler
 * calls, then re-diffs the table at once and returns the position of the
 * batch that carries its echo (or the current one, when nothing changed).
 */
import type { TablePosition } from "@abacus-ai/contract/contract/rows";

import type { RpcContext } from "../context";
import {
  badRequest,
  forbidden,
  notFound,
  unwrapResult,
  workspaceFailure,
} from "../errors";
import type { TableFeed } from "../tables/table-feed";
import { impl } from "./impl";

const echo = <Row, Key extends string>(
  feed: TableFeed<Row, Key>,
  key: Key
): TablePosition<Key> => ({ epoch: feed.epoch, seq: feed.notifyNow(), key });

const read = <Row, Key extends string>(
  table: (context: RpcContext) => TableFeed<Row, Key>
) => ({
  snapshot: ({ context }: { context: RpcContext }) => table(context).snapshot(),
  changes: ({
    context,
    signal,
  }: {
    context: RpcContext;
    signal?: AbortSignal;
  }) => table(context).subscribe(signal),
});

const sessions = read((context) => context.deps.tables.sessions);
const bots = read((context) => context.deps.tables.bots);
const routines = read((context) => context.deps.tables.routines);
const routineRuns = read((context) => context.deps.tables.routineRuns);
const artifacts = read((context) => context.deps.tables.artifacts);
const memories = read((context) => context.deps.tables.memories);
const workspaces = read((context) => context.deps.tables.workspaces);
const gitState = read((context) => context.deps.tables.gitState);
const prefs = read((context) => context.deps.tables.prefs);

/** The session fields a client may write; the rest are main's. */
const WRITABLE_SESSION_FIELDS = new Set(["label", "model"]);

export const dbRouter = impl.db.router({
  sessions: {
    snapshot: impl.db.sessions.snapshot.handler(sessions.snapshot),
    changes: impl.db.sessions.changes.handler(sessions.changes),
    insert: impl.db.sessions.insert.handler(({ input, context }) => {
      const session = context.deps.serviceHost.createAgentSession(
        input.workspaceId,
        null,
        null,
        input.id,
        { model: input.model ?? null, mode: input.mode ?? null }
      );
      return echo(context.deps.tables.sessions, session.id);
    }),
    update: impl.db.sessions.update.handler(({ input, context }) => {
      const readOnly = Object.keys(input.patch).filter(
        (field) => !WRITABLE_SESSION_FIELDS.has(field)
      );
      if (readOnly.length > 0)
        throw forbidden(`read-only field: ${readOnly.join(", ")}`);
      const { serviceHost } = context.deps;
      const session = serviceHost
        .listAllAgentSessions()
        .find((entry) => entry.id === input.id);
      if (session == null) throw notFound("session", input.id);
      if (input.patch.label !== undefined)
        serviceHost.updateAgentSessionLabel(
          session.workspaceId,
          session.id,
          input.patch.label
        );
      if (input.patch.model !== undefined)
        serviceHost.setAgentSessionModel(
          session.workspaceId,
          session.id,
          input.patch.model
        );
      return echo(context.deps.tables.sessions, session.id);
    }),
    delete: impl.db.sessions.delete.handler(({ input, context }) => {
      const { serviceHost } = context.deps;
      const session = serviceHost
        .listAllAgentSessions()
        .find((entry) => entry.id === input.id);
      if (session == null) throw notFound("session", input.id);
      serviceHost.removeAgentSession(session.workspaceId, session.id);
      return echo(context.deps.tables.sessions, session.id);
    }),
  },
  bots: {
    snapshot: impl.db.bots.snapshot.handler(bots.snapshot),
    changes: impl.db.bots.changes.handler(bots.changes),
    insert: impl.db.bots.insert.handler(({ input, context }) => {
      const { id, ...create } = input;
      const bot = context.deps.serviceHost.createBot(create, id);
      return echo(context.deps.tables.bots, bot.id);
    }),
    update: impl.db.bots.update.handler(({ input, context }) => {
      context.deps.serviceHost.updateBot(input.id, input.patch);
      return echo(context.deps.tables.bots, input.id);
    }),
    delete: impl.db.bots.delete.handler(({ input, context }) => {
      context.deps.serviceHost.deleteBot(input.id);
      return echo(context.deps.tables.bots, input.id);
    }),
  },
  routines: {
    snapshot: impl.db.routines.snapshot.handler(routines.snapshot),
    changes: impl.db.routines.changes.handler(routines.changes),
    insert: impl.db.routines.insert.handler(async ({ input, context }) => {
      const { id, ...create } = input;
      const routine = await context.deps.serviceHost.createRoutine(create, id);
      return echo(context.deps.tables.routines, routine.id);
    }),
    update: impl.db.routines.update.handler(async ({ input, context }) => {
      await context.deps.serviceHost.updateRoutine(input.id, input.patch);
      return echo(context.deps.tables.routines, input.id);
    }),
    delete: impl.db.routines.delete.handler(async ({ input, context }) => {
      await context.deps.serviceHost.removeRoutine(input.id);
      return echo(context.deps.tables.routines, input.id);
    }),
  },
  routineRuns: {
    snapshot: impl.db.routineRuns.snapshot.handler(routineRuns.snapshot),
    changes: impl.db.routineRuns.changes.handler(routineRuns.changes),
  },
  artifacts: {
    snapshot: impl.db.artifacts.snapshot.handler(artifacts.snapshot),
    changes: impl.db.artifacts.changes.handler(artifacts.changes),
  },
  memories: {
    snapshot: impl.db.memories.snapshot.handler(memories.snapshot),
    changes: impl.db.memories.changes.handler(memories.changes),
    // The clicked row's index and entry are checked under the store lock: a
    // stale click is CONFLICT, never its successor deleted.
    delete: impl.db.memories.delete.handler(async ({ input, context }) => {
      const { serviceHost } = context.deps;
      if (input.scope === "global") {
        if (input.target == null)
          throw badRequest("A global memory names its target");
        await serviceHost.forgetMemory(
          { target: input.target, index: input.index, entry: input.entry },
          input.occurrences
        );
      } else {
        if (input.botId == null) throw badRequest("A bot memory names its bot");
        serviceHost.forgetBotMemory(
          { botId: input.botId, index: input.index, entry: input.entry },
          input.occurrences
        );
      }
      return echo(context.deps.tables.memories, input.id);
    }),
  },
  workspaces: {
    snapshot: impl.db.workspaces.snapshot.handler(workspaces.snapshot),
    changes: impl.db.workspaces.changes.handler(workspaces.changes),
    update: impl.db.workspaces.update.handler(async ({ input, context }) => {
      unwrapResult(
        await context.deps.serviceHost.updateWorkspaceLabel(
          input.id,
          input.patch.label
        ),
        workspaceFailure(input.id)
      );
      return echo(context.deps.tables.workspaces, input.id);
    }),
    delete: impl.db.workspaces.delete.handler(async ({ input, context }) => {
      unwrapResult(
        await context.deps.serviceHost.removeWorkspace(input.id),
        workspaceFailure(input.id)
      );
      return echo(context.deps.tables.workspaces, input.id);
    }),
  },
  gitState: {
    snapshot: impl.db.gitState.snapshot.handler(gitState.snapshot),
    changes: impl.db.gitState.changes.handler(gitState.changes),
  },
  prefs: {
    snapshot: impl.db.prefs.snapshot.handler(prefs.snapshot),
    changes: impl.db.prefs.changes.handler(prefs.changes),
    update: impl.db.prefs.update.handler(({ input, context }) => {
      context.deps.tables.prefsStore.update(input.patch);
      return echo(context.deps.tables.prefs, "app");
    }),
  },
});
