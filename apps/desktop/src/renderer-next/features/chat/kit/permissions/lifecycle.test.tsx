/** R2-T22: both skins retain the answering card and reconcile host outcomes. */
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeMemoryRelays, memoryRelay } from "#next/test-support/chat-relay";

import * as b from "../../fixtures/builders";
import { SCENARIOS } from "../../fixtures/scenarios";
import { renderRelay } from "../../testing";

let current: Awaited<ReturnType<typeof renderRelay>> | null = null;
afterEach(async () => {
  await current?.cleanup();
  current = null;
  closeMemoryRelays();
  vi.useRealTimers();
});
const events = () =>
  SCENARIOS.find((s) => s.id === "perm-two-pending")!.events();

describe("R2-T22 permission lifecycle", () => {
  it.each(["session", "bot"] as const)(
    "%s answers two requests in reverse order",
    async (skin) => {
      const relay = await memoryRelay({ events: events() });
      current = await renderRelay(relay, skin);
      const session = current.runtime.session(relay.threadId);
      const initial = session.store.state.permissions.items;
      if (skin === "session")
        fireEvent.click(
          screen
            .getAllByRole("button")
            .find((button) => button.textContent?.startsWith("Edit"))!
        );
      const second = await screen.findByRole("group", {
        name: "Edit workspace-view.tsx?",
      });
      fireEvent.click(
        within(second).getByRole("button", { name: /^(Allow once|Allow)$/ })
      );
      await waitFor(() => expect(relay.stats.respond).toHaveLength(1));
      expect(
        (relay.stats.respond[0]!.lineage as { permissionId: string })
          .permissionId
      ).toBe("p2");
      expect(second.isConnected).toBe(true);
      relay.emit(
        b.custom("permission.pending", {
          incarnation: "inc-1",
          items: initial.filter((d) => d.id === "p1"),
        })
      );
      await waitFor(() =>
        expect(document.querySelector('[data-permission="p1"]')).toBeTruthy()
      );
      const first = document.querySelector(
        '[data-permission="p1"]'
      ) as HTMLElement;
      fireEvent.click(
        within(first).getByRole("button", { name: /^(Allow once|Allow)$/ })
      );
      await waitFor(() => expect(relay.stats.respond).toHaveLength(2));
      expect(
        relay.stats.respond.map(
          (r) => (r.lineage as { permissionId: string }).permissionId
        )
      ).toEqual(["p2", "p1"]);
      relay.emit(
        b.custom("permission.pending", { incarnation: "inc-1", items: [] })
      );
      await waitFor(() =>
        expect(
          document.querySelectorAll('[data-slot="permission-card"]')
        ).toHaveLength(0)
      );
    }
  );

  it("rejection and the 10 s timeout stay on the selected card", async () => {
    let reject = true;
    const relay = await memoryRelay({
      events: events(),
      onRespond: (input, source) => {
        if (reject)
          source.emit(
            b.custom("permission.response_rejected", {
              lineage: input.lineage,
              reason: "invalid",
            })
          );
      },
    });
    current = await renderRelay(relay, "session");
    fireEvent.click(
      screen
        .getAllByRole("button")
        .find((button) => button.textContent?.startsWith("Edit"))!
    );
    const selected = await screen.findByRole("group", {
      name: "Edit workspace-view.tsx?",
    });
    fireEvent.click(
      within(selected).getByRole("button", { name: /^(Allow once|Allow)$/ })
    );
    expect(
      await within(selected).findByText(/Couldn.t send that answer/i)
    ).toBeTruthy();
    expect(selected.isConnected).toBe(true);
    reject = false;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(
      within(selected).getByRole("button", { name: /^(Allow once|Allow)$/ })
    );
    await waitFor(() => expect(relay.stats.respond).toHaveLength(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10001);
    });
    expect(
      within(selected).getByText("No response from the agent. Try again.")
    ).toBeTruthy();
    expect(selected.isConnected).toBe(true);
    relay.emit(
      b.custom("permission.pending", { incarnation: "inc-1", items: [] })
    );
    await waitFor(() => expect(selected.isConnected).toBe(false));
  });

  it.each(["permission.resolved", "permission.pending"])(
    "%s from another window removes the card without a local response",
    async (name) => {
      const relay = await memoryRelay({ events: events() });
      current = await renderRelay(relay, "session");
      const session = current.runtime.session(relay.threadId);
      const lineage =
        session.store.state.permissions.items[0]!.metadata.abacus.lineage;
      relay.emit(
        name === "permission.resolved"
          ? b.custom(name, { permissionId: lineage.permissionId })
          : b.custom(name, { incarnation: "inc-1", items: [] })
      );
      relay.emit(
        b.custom("permission.pending", { incarnation: "inc-1", items: [] })
      );
      await waitFor(() =>
        expect(
          session.store.state.permissions.items.some(
            (d) => d.id === lineage.permissionId
          )
        ).toBe(false)
      );
      expect(relay.stats.respond).toHaveLength(0);
    }
  );
});

it("route permission actions receive the card descriptor without admitting or answering it", async () => {
  const relay = await memoryRelay({ events: events() });
  const show = vi.fn((descriptor: { id: string }) => (
    <button>Terminal {descriptor.id}</button>
  ));
  current = await renderRelay(
    relay,
    "session",
    {},
    { slots: { permissionActions: show } }
  );
  fireEvent.click(
    screen
      .getAllByRole("button")
      .find((b) => b.textContent?.startsWith("Edit"))!
  );
  await screen.findByRole("button", { name: "Terminal p2" });
  expect(show.mock.calls.some(([descriptor]) => descriptor.id === "p2")).toBe(
    true
  );
  expect(relay.stats.respond).toHaveLength(0);
});
