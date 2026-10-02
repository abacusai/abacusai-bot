/** R1-T4 (bots): the live sidebar over a real collection and a fixture table. */
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createCollections, type Collections } from "#next/data/collections";
import { directDbSource, FixtureDb } from "#next/data/fixture-db/fixture-db";
import { fixtureBots, fixturePrefs } from "#next/data/fixture-db/rows";
import { renderInRouter } from "#next/test-support/render-in-router";

import { BotsSidebar, orderBots } from "./bots-sidebar";

let collections: Collections | null = null;
afterEach(async () => {
  for (const collection of Object.values(collections ?? {}))
    await collection.cleanup().catch(() => undefined);
  collections = null;
});

const setup = (db: FixtureDb) => {
  collections = createCollections(directDbSource(db), { backoffMs: [5] });
  return collections;
};

const rowTexts = () =>
  within(screen.getByRole("navigation", { name: "Bots" }))
    .getAllByRole("link")
    .map((link) => link.textContent ?? "")
    .filter((text) => text !== "");

describe("BotsSidebar", () => {
  it("orders pinned bots first, then newest first", () => {
    const bots = [
      { id: "a", updatedAt: 1 },
      { id: "b", updatedAt: 3 },
      { id: "c", updatedAt: 2 },
    ] as never[];
    expect(orderBots(bots, ["a"]).map((bot: { id: string }) => bot.id)).toEqual(
      ["a", "b", "c"]
    );
  });

  it("renders live rows, pinned first, and updates a row in place", async () => {
    const db = new FixtureDb({
      prefs: fixturePrefs({
        pinned: { sessionIds: [], botIds: ["trend-scout"] },
      }),
      bots: fixtureBots(1_800_000_000_000),
    });
    await renderInRouter(<BotsSidebar />, setup(db));
    await screen.findByText("Chief of Staff");
    await waitFor(() => expect(rowTexts()[0]).toContain("Trend Scout"));
    const row = screen.getByText("Morning Brief").closest("a")!;
    act(() => {
      db.bots.upsert({ ...db.bots.rows.get("morning-brief")!, name: "Brief" });
    });
    await screen.findByText("Brief");
    expect(screen.getByText("Brief").closest("a")).toBe(row);
    act(() => {
      db.bots.remove("follow-up-tracker");
    });
    await waitFor(() =>
      expect(screen.queryByText("Follow-Up Tracker")).toBeNull()
    );
  });

  it("shows skeletons while loading", async () => {
    const db = new FixtureDb({ bots: fixtureBots() });
    const release = db.bots.holdSnapshot();
    await renderInRouter(<BotsSidebar />, setup(db));
    expect(await screen.findByTestId("nav-list-skeleton")).toBeTruthy();
    release();
    await screen.findByText("Chief of Staff");
    expect(screen.queryByTestId("nav-list-skeleton")).toBeNull();
  });

  it("shows an error with a working Retry after markError", async () => {
    const db = new FixtureDb({ bots: fixtureBots() });
    db.bots.failSnapshot = new Error("UNAVAILABLE");
    await renderInRouter(<BotsSidebar />, setup(db));
    const retry = await screen.findByRole("button", { name: "Retry" });
    db.bots.failSnapshot = null;
    fireEvent.click(retry);
    expect(
      await screen.findByText("Chief of Staff", undefined, { timeout: 3_000 })
    ).toBeTruthy();
  });
});
