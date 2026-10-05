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

import type { DbSource } from "../collections/table-source";
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

export const createMemoryDbSource = (
  seed: FixtureSeed = defaultFixtureSeed()
): { db: FixtureDb; source: DbSource } => {
  const db = new FixtureDb(seed);
  const transport = createMemoryTransport(buildRouter(db), {});
  return { db, source: async () => transport.client.db };
};
