/**
 * A whole fake `db.*`: one FixtureTable per table plus the mutations main
 * would perform, reachable either directly (tests) or through a real oRPC
 * memory transport (the dev fixture mode; see ./memory-source.ts).
 */
import type {
  ArtifactRow,
  BotRow,
  GitStateRow,
  MemoryRow,
  PrefsRow,
  RoutineRow,
  RoutineRunRow,
  SessionRow,
  PrefsPatch,
  TablePosition,
  WorkspaceRow,
} from "#shared/contract";

import type { LazyTransport } from "../db/tables";
import type { Transport } from "../transport/types";
import { FixtureTable } from "./fixture-table";
import { fixturePrefs } from "./rows";

export interface FixtureSeed {
  prefs?: PrefsRow;
  bots?: BotRow[];
  sessions?: SessionRow[];
  workspaces?: WorkspaceRow[];
  routines?: RoutineRow[];
  routineRuns?: RoutineRunRow[];
  artifacts?: ArtifactRow[];
  memories?: MemoryRow[];
  gitState?: GitStateRow[];
}

type DbClient = Transport["client"]["db"];

const PREFS_GROUPS: ReadonlySet<string> = new Set([
  "sidebar",
  "pinned",
  "models",
  "dismissals",
  "motion",
  "sounds",
]);

export class FixtureDb {
  readonly prefs: FixtureTable<PrefsRow, "app">;
  readonly bots: FixtureTable<BotRow>;
  readonly sessions: FixtureTable<SessionRow>;
  readonly workspaces: FixtureTable<WorkspaceRow>;
  readonly routines: FixtureTable<RoutineRow>;
  readonly routineRuns: FixtureTable<RoutineRunRow>;
  readonly artifacts: FixtureTable<ArtifactRow>;
  readonly memories: FixtureTable<MemoryRow>;
  readonly gitState: FixtureTable<GitStateRow>;

  constructor(seed: FixtureSeed = {}) {
    this.prefs = new FixtureTable(
      (row) => row.id,
      [seed.prefs ?? fixturePrefs()]
    );
    this.bots = new FixtureTable((row) => row.id, seed.bots);
    this.sessions = new FixtureTable((row) => row.id, seed.sessions);
    this.workspaces = new FixtureTable((row) => row.id, seed.workspaces);
    this.routines = new FixtureTable((row) => row.id, seed.routines);
    this.routineRuns = new FixtureTable(
      (row) => row.sessionId,
      seed.routineRuns
    );
    this.artifacts = new FixtureTable((row) => row.id, seed.artifacts);
    this.memories = new FixtureTable((row) => row.id, seed.memories);
    this.gitState = new FixtureTable((row) => row.checkoutKey, seed.gitState);
  }

  /** Main's merge (spec 00 B.2): a group takes only the leaves it names. */
  updatePrefs(patch: PrefsPatch): TablePosition<"app"> {
    const current = this.prefs.rows.get("app") ?? fixturePrefs();
    const next: Record<string, unknown> = { ...current };
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const before = next[field];
      next[field] =
        PREFS_GROUPS.has(field) && typeof before === "object" && before != null
          ? { ...before, ...(value as object) }
          : value;
    }
    return this.prefs.upsert({
      ...(next as unknown as PrefsRow),
      id: "app",
      updatedAt: new Date().toISOString(),
    });
  }

  insertBot(input: Partial<BotRow> & { name: string }): TablePosition {
    const now = Date.now();
    return this.bots.upsert({
      id: input.id ?? crypto.randomUUID(),
      title: "",
      description: "",
      persona: "",
      avatarColor: "#a855f7",
      avatarShape: "round",
      workspaceId: null,
      sessionId: null,
      channel: null,
      model: null,
      createdAt: now,
      ...input,
      name: input.name.trim(),
      updatedAt: now,
    });
  }

  updateRow<Row extends object>(
    table: FixtureTable<Row>,
    id: string,
    patch: Partial<Row>,
    stamp?: (row: Row) => Partial<Row>
  ): TablePosition {
    const current = table.rows.get(id);
    if (current == null) throw new Error(`no row ${id}`);
    const next = { ...current, ...patch };
    return table.upsert({ ...next, ...stamp?.(next) });
  }
}

const tableClient = <Row extends object, Key extends string>(
  table: FixtureTable<Row, Key>,
  mutations: {
    insert?: (input: never) => TablePosition<Key>;
    update?: (input: never) => TablePosition<Key>;
    delete?: (input: never) => TablePosition<Key>;
  } = {}
) => ({
  snapshot: () => table.snapshot(),
  changes: async (_input?: unknown, options?: { signal?: AbortSignal }) =>
    table.subscribe(options?.signal),
  ...(mutations.insert == null
    ? {}
    : { insert: async (input: never) => mutations.insert!(input) }),
  ...(mutations.update == null
    ? {}
    : { update: async (input: never) => mutations.update!(input) }),
  ...(mutations.delete == null
    ? {}
    : { delete: async (input: never) => mutations.delete!(input) }),
});

/** The `db` client shape over a FixtureDb, with no transport in between. */
export const fixtureDbClient = (db: FixtureDb): DbClient =>
  ({
    prefs: tableClient(db.prefs, {
      update: ({ patch }: { patch: PrefsPatch }) => db.updatePrefs(patch),
    }),
    bots: tableClient(db.bots, {
      insert: (input: BotRow) => db.insertBot(input),
      update: ({ id, patch }: { id: string; patch: Partial<BotRow> }) =>
        db.updateRow(db.bots, id, patch, () => ({ updatedAt: Date.now() })),
      delete: ({ id }: { id: string }) => db.bots.remove(id),
    }),
    sessions: tableClient(db.sessions, {
      insert: (input: {
        id: string;
        workspaceId: string;
        model?: string | null;
        mode?: SessionRow["mode"];
      }) => {
        const now = new Date().toISOString();
        return db.sessions.upsert({
          id: input.id,
          workspaceId: input.workspaceId,
          label: "",
          conversationId: null,
          createdAt: now,
          updatedAt: now,
          status: "stopped",
          agentStatus: "idle" as SessionRow["agentStatus"],
          model: input.model ?? null,
          mode: input.mode ?? null,
          worktreeId: null,
          worktreePath: null,
          worktreeBranch: null,
          worktreeOperationId: null,
          routineId: null,
          runOutcome: null,
          runTrigger: null,
          editorFor: null,
          botOwned: false,
          owner: null,
          turn: null,
        });
      },
      update: ({ id, patch }: { id: string; patch: Partial<SessionRow> }) =>
        db.updateRow(db.sessions, id, patch, () => ({
          updatedAt: new Date().toISOString(),
        })),
      delete: ({ id }: { id: string }) => db.sessions.remove(id),
    }),
    workspaces: tableClient(db.workspaces, {
      update: ({ id, patch }: { id: string; patch: Partial<WorkspaceRow> }) =>
        db.updateRow(db.workspaces, id, patch),
      delete: ({ id }: { id: string }) => db.workspaces.remove(id),
    }),
    routines: tableClient(db.routines, {
      insert: (input: Partial<RoutineRow> & { id: string; prompt: string }) =>
        db.routines.upsert({
          name: "Check-in",
          schedule: null,
          runAt: null,
          webhookToken: null,
          workspaceId: null,
          botId: null,
          enabled: true,
          createdAt: Date.now(),
          lastRunAt: null,
          lastResult: null,
          nextRunAt: null,
          webhookUrl: null,
          webhookPublicPending: false,
          botName: null,
          recentRuns: [],
          ...input,
        }),
      update: ({ id, patch }: { id: string; patch: Partial<RoutineRow> }) =>
        db.updateRow(db.routines, id, patch),
      delete: ({ id }: { id: string }) => db.routines.remove(id),
    }),
    routineRuns: tableClient(db.routineRuns),
    artifacts: tableClient(db.artifacts),
    memories: tableClient(db.memories, {
      delete: ({ id }: { id: string }) => db.memories.remove(id),
    }),
    gitState: tableClient(db.gitState),
  }) as unknown as DbClient;

/**
 * A lazy transport whose `client.db` is the FixtureDb, with no oRPC in
 * between (tests). Only `db.*` exists on it.
 */
export const fixtureTransport = (db: FixtureDb): LazyTransport => {
  const transport = {
    client: { db: fixtureDbClient(db) },
  } as unknown as Transport;
  return async () => transport;
};
