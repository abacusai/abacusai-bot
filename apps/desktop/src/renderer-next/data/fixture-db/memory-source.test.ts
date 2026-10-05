/**
 * The dev fixture mode (gallery and visual screenshots only): the app's
 * `createDb()` over a FixtureDb served through a real oRPC memory transport
 * (the path `VITE_NEXT_DB_FIXTURES=1` takes).
 */
import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createDb, type Db } from "../db";
import { createMemoryDbTransport } from "./memory-source";

const dbs: Db[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) {
    db.stop();
    for (const collection of Object.values(db.collections))
      await collection.cleanup().catch(() => undefined);
  }
});

describe("createMemoryDbTransport", () => {
  it("serves snapshots, live changes and prefs patches over oRPC", async () => {
    const { db: fixture, transport } = createMemoryDbTransport();
    const db = createDb(transport, { retryDelayMs: () => 5 });
    dbs.push(db);
    const { bots, prefs } = db.collections;
    await bots.preload();
    expect(bots.size).toBe(5);

    fixture.bots.remove("trend-scout");
    await waitFor(() => expect(bots.has("trend-scout")).toBe(false));

    await prefs.preload();
    await db.updatePrefs({ theme: "dark" });
    expect(fixture.prefs.rows.get("app")?.theme).toBe("dark");
  });
});
