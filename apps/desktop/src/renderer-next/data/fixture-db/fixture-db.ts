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
  TablePosition,
  WorkspaceRow,
} from "#shared/contract";

import type { DbClient, DbSource } from "../collections/table-source";
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
    this.gitState = new FixtureTable((row) => row.workspaceId, seed.gitState);
  }

  updatePrefs(patch: Partial<PrefsRow>): TablePosition<"app"> {
    const current = this.prefs.rows.get("app") ?? fixturePrefs();
    return this.prefs.upsert({
      ...current,
      ...patch,
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
      update: ({ patch }: { patch: Partial<PrefsRow> }) =>
        db.updatePrefs(patch),
    }),
    bots: tableClient(db.bots, {
      insert: (input: BotRow) => db.insertBot(input),
      update: ({ id, patch }: { id: string; patch: Partial<BotRow> }) =>
        db.updateRow(db.bots, id, patch, () => ({ updatedAt: Date.now() })),
      delete: ({ id }: { id: string }) => db.bots.remove(id),
    }),
    sessions: tableClient(db.sessions, {
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

export const directDbSource =
  (db: FixtureDb): DbSource =>
  async () =>
    fixtureDbClient(db);
