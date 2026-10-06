/**
 * The connectors slide (canvas OnboardConnectors): the curated grid in the
 * canvas's order, Connected/Connect from the live statuses, "Many more…"
 * expanding inside the slide (no navigation) to every other platform entry,
 * and the second continue only while nothing is attached or queued.
 */
import { CONNECTORS } from "@abacus-ai/connectors/registry";
import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PREFS } from "#renderer/data/db/prefs";
import { fixedT, initI18n } from "#renderer/lib/i18n";

import { ConnectorsStep, CURATED_IDS, connectorTiles } from "./connectors";
import type { StepContext } from "./context";

const prefs = { current: { ...DEFAULT_PREFS } };
vi.mock("#renderer/data/db/prefs", async (original) => ({
  ...(await original<typeof import("#renderer/data/db/prefs")>()),
  usePrefs: () => prefs.current,
}));

const ctx = (overrides: Partial<StepContext["props"]> = {}): StepContext => {
  const props = {
    step: "connectors",
    transport: {} as never,
    facts: { signedIn: true, payingTier: false, ownsBot: true },
    navigate: vi.fn(async () => {}),
    signIn: vi.fn(),
    cancelSignIn: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    createFirstBot: vi.fn(),
    connect: vi.fn(async () => {}),
    ...overrides,
  } as StepContext["props"];
  return {
    props,
    t: fixedT(),
    busy: false,
    perform: async (action) => {
      await action();
    },
    advance: vi.fn(),
    back: vi.fn(),
  };
};

describe("connectorTiles", () => {
  it("leads with the canvas's set, in order, every id a real inline-connectable entry", () => {
    const ids = connectorTiles(undefined, false).map((entry) => entry.id);
    expect(ids).toEqual([...CURATED_IDS]);
    for (const id of ids) {
      const entry = CONNECTORS.find((c) => c.id === id)!;
      expect(["platform", "messaging"]).toContain(entry.kind);
    }
    // Every connector the old step offered is reachable without expanding.
    for (const old of [
      "messaging-whatsapp",
      "messaging-telegram",
      "messaging-discord",
      "abacus-gmailuser",
    ])
      expect(ids).toContain(old);
  });

  it("expands to the rest of the flagged and platform entries, registry order, without duplicates", () => {
    const ids = connectorTiles(undefined, true).map((entry) => entry.id);
    expect(ids.slice(0, CURATED_IDS.length)).toEqual([...CURATED_IDS]);
    expect(new Set(ids).size).toBe(ids.length);
    const expected = CONNECTORS.filter(
      (entry) =>
        !(CURATED_IDS as readonly string[]).includes(entry.id) &&
        (entry.onboarding || entry.kind === "platform")
    ).map((entry) => entry.id);
    expect(ids.slice(CURATED_IDS.length)).toEqual(expected);
    expect(ids).toContain("abacus-onedrive");
    expect(ids).toContain("abacus-confluence");
  });

  it("hides a tile the host does not offer", () => {
    const ids = connectorTiles(
      { "abacus-slack": { state: "disconnected", reason: "not-offered" } },
      false
    ).map((entry) => entry.id);
    expect(ids).not.toContain("abacus-slack");
    expect(ids).toHaveLength(CURATED_IDS.length - 1);
  });
});

describe("ConnectorsStep", () => {
  it("shows Connected from the statuses, expands in place, and drops the skip once something is attached", async () => {
    await initI18n();
    const context = ctx();
    let more = false;
    const setMore = vi.fn((next: boolean) => {
      more = next;
    });
    const view = render(
      <ConnectorsStep
        ctx={context}
        statuses={{ "abacus-gmailuser": { state: "connected" } }}
        refresh={async () => {}}
        more={more}
        setMore={setMore}
        heading={createRef()}
      />
    );
    const tile = (id: string) =>
      view.container.querySelector(`[data-connector="${id}"]`)!;
    expect(tile("abacus-gmailuser").getAttribute("data-connected")).toBe(
      "true"
    );
    expect(tile("abacus-gmailuser").textContent).toContain("Connected");
    expect(tile("abacus-slack").textContent).toContain("Connect");
    expect(view.container.querySelectorAll("[data-connector]")).toHaveLength(
      CURATED_IDS.length
    );
    expect(
      screen.queryByRole("button", { name: "Continue without connectors" })
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Many more…" }));
    expect(setMore).toHaveBeenCalledWith(true);
    view.rerender(
      <ConnectorsStep
        ctx={context}
        statuses={{ "abacus-gmailuser": { state: "connected" } }}
        refresh={async () => {}}
        more={true}
        setMore={setMore}
        heading={createRef()}
      />
    );
    expect(
      view.container.querySelectorAll("[data-connector]").length
    ).toBeGreaterThan(CURATED_IDS.length);
    expect(screen.queryByRole("button", { name: "Many more…" })).toBeNull();
    expect(context.props.navigate).not.toHaveBeenCalled();
  });

  it("connects through the route's flow and refreshes; continues per the bot facts", async () => {
    await initI18n();
    const context = ctx({
      facts: { signedIn: true, payingTier: false, ownsBot: false },
    });
    const refresh = vi.fn(async () => {});
    render(
      <ConnectorsStep
        ctx={context}
        statuses={{}}
        refresh={refresh}
        more={false}
        setMore={() => {}}
        heading={createRef()}
      />
    );
    const slack = screen
      .getByText("Slack")
      .closest("[data-connector]")!
      .querySelector("button")!;
    fireEvent.click(slack);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(context.props.connect).toHaveBeenCalledWith("abacus-slack");
    expect(
      screen.getByRole("button", { name: "Continue without connectors" })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await vi.waitFor(() =>
      expect(context.props.complete).toHaveBeenCalledWith({ to: "new-bot" })
    );
    expect(context.advance).not.toHaveBeenCalled();
  });
});
