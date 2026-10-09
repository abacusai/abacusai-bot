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
  it("offers the original email and messaging choices through real connector entries", () => {
    const ids = connectorTiles(undefined).map((entry) => entry.id);
    expect(ids).toEqual([...CURATED_IDS]);
    for (const id of ids) {
      const entry = CONNECTORS.find((c) => c.id === id)!;
      expect(["platform", "messaging"]).toContain(entry.kind);
    }
    expect(ids).toEqual([
      "abacus-gmailuser",
      "messaging-whatsapp",
      "messaging-telegram",
      "messaging-discord",
    ]);
  });

  it("hides a tile the host does not offer", () => {
    const ids = connectorTiles({
      "abacus-gmailuser": { state: "disconnected", reason: "not-offered" },
    }).map((entry) => entry.id);
    expect(ids).not.toContain("abacus-gmailuser");
    expect(ids).toHaveLength(CURATED_IDS.length - 1);
  });
});

describe("ConnectorsStep", () => {
  it("shows connected status and keeps the full catalog out of onboarding", async () => {
    await initI18n();
    const context = ctx();
    const view = render(
      <ConnectorsStep
        ctx={context}
        statuses={{ "abacus-gmailuser": { state: "connected" } }}
        refresh={async () => {}}
        heading={createRef()}
      />
    );
    const tile = (id: string) =>
      view.container.querySelector(`[data-connector="${id}"]`)!;
    expect(tile("abacus-gmailuser").getAttribute("data-connected")).toBe(
      "true"
    );
    expect(tile("abacus-gmailuser").textContent).toContain("Connected");
    expect(tile("abacus-gmailuser").tagName).toBe("BUTTON");
    expect(tile("abacus-gmailuser").getAttribute("aria-pressed")).toBe("true");
    expect(tile("messaging-whatsapp").querySelectorAll("button")).toHaveLength(
      0
    );
    expect(
      tile("messaging-whatsapp").querySelector('[data-slot="connector-state"]')
    ).not.toBeNull();
    expect(tile("messaging-whatsapp").getAttribute("data-state")).toBe("idle");

    expect(view.container.querySelectorAll("[data-connector]")).toHaveLength(
      CURATED_IDS.length
    );
    expect(
      screen.queryByRole("button", { name: "Continue without connectors" })
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Many more…" })).toBeNull();
    expect(context.props.navigate).not.toHaveBeenCalled();
  });

  it.each([
    ["Gmail", "abacus-gmailuser"],
    ["WhatsApp", "messaging-whatsapp"],
    ["Telegram", "messaging-telegram"],
    ["Discord", "messaging-discord"],
  ])(
    "connects %s through the route flow and refreshes before continuing",
    async (name, id) => {
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
          heading={createRef()}
        />
      );
      const connect = screen.getByRole("button", { name: `Connect ${name}` });
      const description = document.getElementById(
        connect.getAttribute("aria-describedby")!
      );
      expect(description?.textContent).toBeTruthy();
      fireEvent.click(connect);
      await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
      expect(context.props.connect).toHaveBeenCalledWith(id);
      expect(
        screen.getByRole("button", { name: "Continue without connectors" })
      ).toBeTruthy();
      const skip = screen.getByRole("button", {
        name: "Continue without connectors",
      });
      expect(skip.className).toContain("text-muted-foreground");
      expect(skip.className).not.toContain("bg-primary");
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(context.advance).toHaveBeenCalledOnce();
      expect(context.props.complete).not.toHaveBeenCalled();
    }
  );
});
