/**
 * R1-T3 (the interim adapter's core; the full spec 00 B-T1 suite belongs to
 * the data/db adapter): real `createCollection` over the fixture table.
 */
import { createCollection } from "@tanstack/db";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { BotRow } from "#shared/contract";

import { FixtureDb, directDbSource } from "../fixture-db/fixture-db";
import { FixtureTable } from "../fixture-db/fixture-table";
import { fixtureBots, fixturePrefs } from "../fixture-db/rows";
import { CollectionsProvider, createCollections } from "./index";
import { ipcCollectionOptions } from "./ipc-collection-options";
import { DEFAULT_PREFS, updatePrefs, usePrefs } from "./prefs";

const FAST = [5, 5, 5] as const;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const botsOver = (table: FixtureTable<BotRow>) => {
  const client = {
    snapshot: () => table.snapshot(),
    changes: async (_: unknown, options?: { signal?: AbortSignal }) =>
      table.subscribe(options?.signal),
    update: async ({ id, patch }: { id: string; patch: Partial<BotRow> }) => {
      const row = table.rows.get(id)!;
      // Main normalises: trims the name, stamps updatedAt.
      return table.upsert({
        ...row,
        ...patch,
        name: (patch.name ?? row.name).trim(),
        updatedAt: row.updatedAt + 1,
      });
    },
  };
  const collection = createCollection(
    ipcCollectionOptions<BotRow, string>({
      id: `bots-${Math.random()}`,
      table: async () => client as never,
      getKey: (row) => row.id,
      toUpdateInput: (id, changes) => ({ id, patch: changes }),
      backoffMs: FAST,
      echoTimeoutMs: 200,
    })
  );
  cleanups.push(() => collection.cleanup());
  return collection;
};

describe("ipcCollectionOptions", () => {
  it("loads the snapshot, then applies live batches in order", async () => {
    const table = new FixtureTable<BotRow>((row) => row.id, fixtureBots(1e12));
    const bots = botsOver(table);
    await bots.preload();
    expect(bots.size).toBe(5);
    table.remove("trend-scout");
    table.upsert({ ...table.rows.get("meeting-prep")!, name: "Prep" });
    await waitFor(() => expect(bots.get("meeting-prep")?.name).toBe("Prep"));
    expect(bots.has("trend-scout")).toBe(false);
    expect(bots.utils.status().receivedSeq).toBe(2);
  });

  it("buffers batches that arrive during the snapshot and drops ones it already has", async () => {
    const table = new FixtureTable<BotRow>((row) => row.id, fixtureBots(1e12));
    const release = table.holdSnapshot();
    const bots = botsOver(table);
    const ready = bots.preload();
    await waitFor(() => expect(table.subscriberCount).toBe(1));
    // Taken into the snapshot too (seq 1 <= snapshot seq): must be dropped.
    table.remove("trend-scout");
    release();
    await ready;
    table.upsert({ ...table.rows.get("morning-brief")!, name: "Brief" });
    await waitFor(() => expect(bots.get("morning-brief")?.name).toBe("Brief"));
    expect(bots.size).toBe(4);
  });

  it("re-snapshots on reset and reopens after the EOF that follows", async () => {
    const table = new FixtureTable<BotRow>((row) => row.id, fixtureBots(1e12));
    const bots = botsOver(table);
    await bots.preload();
    table.rows.delete("trend-scout"); // silently, as a lost batch would
    table.reset();
    await waitFor(() => expect(bots.has("trend-scout")).toBe(false));
    await waitFor(() => expect(table.subscriberCount).toBe(1));
    table.upsert({ ...table.rows.get("chief-of-staff")!, name: "Chief" });
    await waitFor(() => expect(bots.get("chief-of-staff")?.name).toBe("Chief"));
  });

  it("resets positions on a new epoch", async () => {
    const table = new FixtureTable<BotRow>((row) => row.id, fixtureBots(1e12));
    const bots = botsOver(table);
    await bots.preload();
    table.upsert({ ...table.rows.get("chief-of-staff")!, name: "A" });
    const oldEpoch = table.epoch;
    table.setEpoch();
    await waitFor(() => expect(bots.utils.status().epoch).not.toBe(oldEpoch));
    await waitFor(() => expect(bots.utils.status().receivedSeq).toBe(0));
    expect(bots.get("chief-of-staff")?.name).toBe("A");
  });

  it("marks an error when the first snapshot fails, then recovers", async () => {
    const table = new FixtureTable<BotRow>((row) => row.id, fixtureBots(1e12));
    table.failSnapshot = new Error("UNAVAILABLE");
    const bots = botsOver(table);
    bots.startSyncImmediate();
    await waitFor(() => expect(bots.status).toBe("error"));
    table.failSnapshot = null;
    await waitFor(() => expect(bots.status).toBe("ready"), { timeout: 2_000 });
    expect(bots.size).toBe(5);
  });

  it("settles an update on the echo, with the server's normalised value", async () => {
    const table = new FixtureTable<BotRow>((row) => row.id, fixtureBots(1e12));
    const bots = botsOver(table);
    await bots.preload();
    const seen: string[] = [];
    const subscription = bots.subscribeChanges((changes) => {
      for (const change of changes)
        if (change.key === "chief-of-staff" && change.value)
          seen.push(change.value.name);
    });
    const tx = bots.update("chief-of-staff", (draft) => {
      draft.name = "  Chief  ";
    });
    await tx.isPersisted.promise;
    subscription.unsubscribe();
    expect(bots.get("chief-of-staff")?.name).toBe("Chief");
    expect(seen.at(-1)).toBe("Chief");
    expect(seen).not.toContain("Chief of Staff");
  });

  it("awaitApplied resolves once the batch is visible", async () => {
    const table = new FixtureTable<BotRow>((row) => row.id, fixtureBots(1e12));
    const bots = botsOver(table);
    await bots.preload();
    const position = table.remove("trend-scout");
    await bots.utils.awaitApplied(position);
    expect(bots.has("trend-scout")).toBe(false);
  });

  it("rejects pending waiters with AbortError on cleanup", async () => {
    const table = new FixtureTable<BotRow>((row) => row.id, fixtureBots(1e12));
    const bots = botsOver(table);
    await bots.preload();
    const pending = bots.utils.awaitReceived({ epoch: table.epoch, seq: 99 });
    await bots.cleanup();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("prefs helpers", () => {
  it("usePrefs gives the defaults, then the row; updatePrefs is optimistic and settles", async () => {
    const db = new FixtureDb({ prefs: fixturePrefs({ theme: "dark" }) });
    const collections = createCollections(directDbSource(db), {
      backoffMs: FAST,
    });
    cleanups.push(() => collections.prefs.cleanup());
    const wrapper = ({ children }: { children: ReactNode }) => (
      <CollectionsProvider value={collections}>{children}</CollectionsProvider>
    );
    const { result } = renderHook(() => usePrefs(), { wrapper });
    expect([DEFAULT_PREFS.theme, "dark"]).toContain(result.current.theme);
    await waitFor(() => expect(result.current.theme).toBe("dark"));

    let settled = false;
    await act(async () => {
      const done = updatePrefs(collections, (draft) => {
        draft.theme = "light";
      }).then(() => {
        settled = true;
      });
      expect(collections.prefs.get("app")?.theme).toBe("light");
      await done;
    });
    expect(settled).toBe(true);
    expect(db.prefs.rows.get("app")?.theme).toBe("light");
    expect(result.current.theme).toBe("light");
  });
});
