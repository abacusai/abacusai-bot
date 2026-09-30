/**
 * The dev fixture mode (VITE_NEXT_DB_FIXTURES=1): main's `db.*` answers
 * UNAVAILABLE until spec 00 sub-slice B lands, so the shell's tables come from
 * a FixtureDb served over a real oRPC memory transport (the same link,
 * serializer and flow control as the MessagePort). Everything else still goes
 * to main. Loaded only through a dynamic import behind the env flag, so
 * production bundles never contain it.
 */
import { implement, type Router } from "@orpc/server";

import { contract } from "#shared/contract";

import type { LazyTransport } from "../db/tables";
import { createMemoryTransport } from "../transport/memory";
import { FixtureDb, fixtureDbClient, type FixtureSeed } from "./fixture-db";
import type { FixtureTable } from "./fixture-table";
import {
  fixtureBots,
  fixturePrefs,
  fixtureRoutines,
  fixtureSessions,
  fixtureWorkspaces,
} from "./rows";

const os = implement(contract);

/**
 * Said once when a fixture build boots; also the marker the Electron
 * acceptance suite looks for in a build to refuse it (acceptance reads
 * main's real db.*).
 */
const FIXTURE_BUILD_MARKER =
  "renderer-next fixture-db: dev fixture tables, not main's db.*";

type Handlerish = (input: never) => unknown;

/** Every `db.<table>.<procedure>` the fixture client has, as a handler. */
const buildRouter = (db: FixtureDb): Router<any, Record<string, never>> => {
  const client = fixtureDbClient(db) as unknown as Record<
    string,
    Record<string, Handlerish>
  >;
  const tables: Record<string, Record<string, unknown>> = {};
  for (const [table, procedures] of Object.entries(client)) {
    const impl = (os.db as unknown as Record<string, Record<string, any>>)[
      table
    ]!;
    tables[table] = {};
    const fixture = (db as unknown as Record<string, FixtureTable<object>>)[
      table
    ]!;
    for (const [name, call] of Object.entries(procedures)) {
      tables[table][name] =
        name === "changes"
          ? // The fixture table's stream ends when the call is aborted.
            impl[name].handler(async function* ({
              signal,
            }: {
              signal?: AbortSignal;
            }) {
              yield* fixture.subscribe(signal);
            })
          : impl[name].handler(({ input }: { input: never }) => call(input));
    }
  }
  return { db: tables } as unknown as Router<any, Record<string, never>>;
};

const defaultFixtureSeed = (): FixtureSeed => ({
  prefs: fixturePrefs(),
  bots: fixtureBots(),
  sessions: fixtureSessions(),
  workspaces: fixtureWorkspaces(),
  routines: fixtureRoutines(),
});

/**
 * The fixture tables over a real oRPC memory transport. Only its `db.*`
 * exists; `createDb(transport)` reads nothing else.
 */
export const createMemoryDbTransport = (
  seed: FixtureSeed = defaultFixtureSeed()
): { db: FixtureDb; transport: LazyTransport } => {
  const db = new FixtureDb(seed);
  const transport = createMemoryTransport(buildRouter(db), {});
  if (import.meta.env.MODE !== "test") console.info(FIXTURE_BUILD_MARKER);
  return { db, transport: async () => transport };
};
