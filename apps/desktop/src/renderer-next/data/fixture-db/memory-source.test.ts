/**
 * The dev fixture mode: the collections over a FixtureDb served through a
 * real oRPC memory transport (the path `VITE_NEXT_DB_FIXTURES=1` takes).
 */
import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createCollections } from "../collections";
import { updatePrefs } from "../collections/prefs";
import { createMemoryDbSource } from "./memory-source";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("createMemoryDbSource", () => {
  it("serves snapshots, live changes and prefs writes over oRPC", async () => {
    const { db, source } = createMemoryDbSource();
    const collections = createCollections(source, { backoffMs: [5] });
    cleanups.push(
      () => collections.bots.cleanup(),
      () => collections.prefs.cleanup(),
      () => collections.sessions.cleanup(),
      () => collections.workspaces.cleanup()
    );
    await collections.bots.preload();
    expect(collections.bots.size).toBe(5);

    db.bots.remove("trend-scout");
    await waitFor(() =>
      expect(collections.bots.has("trend-scout")).toBe(false)
    );

    await collections.prefs.preload();
    await updatePrefs(collections, (draft) => {
      draft.theme = "dark";
    });
    expect(db.prefs.rows.get("app")?.theme).toBe("dark");
  });
});
