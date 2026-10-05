/**
 * R1-T3 against the real adapter (`data/db`, spec 00 B.3): the app's
 * `createDb()` collections over the fixture tables, end to end through the
 * same `ipcCollectionOptions` and table options the app ships. The adapter's
 * protocol cases (spec 00 B-T1) are in ipc-collection-options.test.ts.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FixtureDb, fixtureTransport } from "../fixture-db/fixture-db";
import { fixtureBots, fixturePrefs } from "../fixture-db/rows";
import { createDb, DbProvider, ReadOnlyFieldError, type Db } from "./index";
import { createPaneWidthWriter, DEFAULT_PREFS, usePrefs } from "./prefs";

const dbs: Db[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) {
    db.stop();
    for (const collection of Object.values(db.collections))
      await collection.cleanup().catch(() => undefined);
  }
});

const setup = (fixture: FixtureDb, echoTimeoutMs = 200) => {
  const db = createDb(fixtureTransport(fixture), {
    retryDelayMs: () => 5,
    echoTimeoutMs,
  });
  dbs.push(db);
  return db;
};

describe("createDb collections (R1-T3, real adapter)", () => {
  it("loads the snapshot, then applies live batches in order", async () => {
    const fixture = new FixtureDb({ bots: fixtureBots(1e12) });
    const { bots } = setup(fixture).collections;
    await bots.preload();
    expect(bots.size).toBe(5);
    fixture.bots.remove("trend-scout");
    fixture.bots.upsert({
      ...fixture.bots.rows.get("meeting-prep")!,
      name: "Prep",
    });
    await waitFor(() => expect(bots.get("meeting-prep")?.name).toBe("Prep"));
    expect(bots.has("trend-scout")).toBe(false);
    expect(bots.utils.status().receivedSeq).toBe(2);
  });

  it("buffers batches that arrive during the snapshot and drops ones it already has", async () => {
    const fixture = new FixtureDb({ bots: fixtureBots(1e12) });
    const release = fixture.bots.holdSnapshot();
    const { bots } = setup(fixture).collections;
    const ready = bots.preload();
    await waitFor(() => expect(fixture.bots.subscriberCount).toBe(1));
    fixture.bots.remove("trend-scout");
    release();
    await ready;
    fixture.bots.upsert({
      ...fixture.bots.rows.get("morning-brief")!,
      name: "Brief",
    });
    await waitFor(() => expect(bots.get("morning-brief")?.name).toBe("Brief"));
    expect(bots.size).toBe(4);
  });

  it("re-snapshots on reset and reopens after the EOF that follows", async () => {
    const fixture = new FixtureDb({ bots: fixtureBots(1e12) });
    const { bots } = setup(fixture).collections;
    await bots.preload();
    fixture.bots.rows.delete("trend-scout");
    fixture.bots.reset();
    await waitFor(() => expect(bots.has("trend-scout")).toBe(false));
    await waitFor(() => expect(fixture.bots.subscriberCount).toBe(1));
    fixture.bots.upsert({
      ...fixture.bots.rows.get("chief-of-staff")!,
      name: "Chief",
    });
    await waitFor(() => expect(bots.get("chief-of-staff")?.name).toBe("Chief"));
  });

  it("marks an error when the first snapshot fails, then recovers", async () => {
    const fixture = new FixtureDb({ bots: fixtureBots(1e12) });
    fixture.bots.failSnapshot = new Error("UNAVAILABLE");
    const { bots } = setup(fixture).collections;
    bots.startSyncImmediate();
    await waitFor(() => expect(bots.status).toBe("error"));
    fixture.bots.failSnapshot = null;
    await waitFor(() => expect(bots.status).toBe("ready"), { timeout: 2_000 });
    expect(bots.size).toBe(5);
  });

  it("an insert into the lazy bots table never read starts its sync and settles on the echo", async () => {
    const fixture = new FixtureDb({ bots: fixtureBots(1e12) });
    const { bots } = setup(fixture, 5_000).collections;
    expect(bots.status).toBe("idle");
    const started = Date.now();
    const tx = bots.insert({
      ...fixtureBots(1e12)[0]!,
      id: "new-bot",
      name: "New bot",
    });
    await tx.isPersisted.promise;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fixture.bots.rows.get("new-bot")?.name).toBe("New bot");
    expect(bots.status).toBe("ready");
  });

  it("refuses a read-only field instead of sending it", async () => {
    const fixture = new FixtureDb({ bots: fixtureBots(1e12) });
    const { bots } = setup(fixture).collections;
    await bots.preload();
    const tx = bots.update("chief-of-staff", (draft) => {
      draft.sessionId = "s-1";
    });
    await expect(tx.isPersisted.promise).rejects.toBeInstanceOf(
      ReadOnlyFieldError
    );
    expect(fixture.bots.rows.get("chief-of-staff")?.sessionId).toBeNull();
  });
});

describe("prefs (spec 00 B.2 provenance)", () => {
  it("usePrefs gives the defaults, then the row; updatePrefs is optimistic and settles", async () => {
    const fixture = new FixtureDb({ prefs: fixturePrefs({ theme: "dark" }) });
    const db = setup(fixture);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DbProvider value={db}>{children}</DbProvider>
    );
    const { result } = renderHook(() => usePrefs(), { wrapper });
    expect([DEFAULT_PREFS.theme, "dark"]).toContain(result.current.theme);
    await waitFor(() => expect(result.current.theme).toBe("dark"));

    let settled = false;
    await act(async () => {
      const done = db.updatePrefs({ theme: "light" }).then(() => {
        settled = true;
      });
      expect(db.collections.prefs.get("app")?.theme).toBe("light");
      await done;
    });
    expect(settled).toBe(true);
    expect(fixture.prefs.rows.get("app")?.theme).toBe("light");
    expect(result.current.theme).toBe("light");
  });

  it("⌘B's write sends only sidebar.pinned, never the group's other leaves", async () => {
    const fixture = new FixtureDb({
      prefs: fixturePrefs({ sidebar: { pinned: true, openSection: "bots" } }),
    });
    const sent = vi.spyOn(fixture, "updatePrefs");
    const db = setup(fixture);
    await db.collections.prefs.preload();
    await db.updatePrefs({ sidebar: { pinned: false } });
    expect(sent).toHaveBeenCalledWith({ sidebar: { pinned: false } });
    expect(fixture.prefs.rows.get("app")?.sidebar).toEqual({
      pinned: false,
      openSection: "bots",
    });
    expect(db.collections.prefs.get("app")?.sidebar.openSection).toBe("bots");
  });

  it("an explicit choice of the current value is still sent (it becomes the user's)", async () => {
    const fixture = new FixtureDb({ prefs: fixturePrefs({ theme: "dark" }) });
    const sent = vi.spyOn(fixture, "updatePrefs");
    const db = setup(fixture);
    await db.collections.prefs.preload();
    await db.updatePrefs({ theme: "dark" });
    expect(sent).toHaveBeenCalledWith({ theme: "dark" });
  });

  it("the pane width writer debounces and carries the other panes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fixture = new FixtureDb({
        prefs: fixturePrefs({ panes: { other: 300 } }),
      });
      const sent = vi.spyOn(fixture, "updatePrefs");
      const db = setup(fixture);
      await db.collections.prefs.preload();
      const writer = createPaneWidthWriter(db, "side-panel", 300);
      writer.write(401.2);
      writer.write(420.6);
      await vi.advanceTimersByTimeAsync(350);
      await waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
      expect(sent).toHaveBeenCalledWith({
        panes: { other: 300, "side-panel": 421 },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
