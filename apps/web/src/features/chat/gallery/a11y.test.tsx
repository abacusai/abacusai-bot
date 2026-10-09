/**
 * R2-T26 (spec 02 §12.1): axe (WCAG 2 A/AA; `color-contrast` and `region`
 * off in jsdom, as R1-T8) over every chat scenario; every icon-only button
 * has a name; cards are labelled groups; the tray's chips carry
 * `aria-pressed`; the status region announces a milestone once.
 */
import { act, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

import * as b from "../fixtures/builders";
import { SCENARIOS } from "../fixtures/scenarios";
import { renderScenario } from "../testing";

let current: Awaited<ReturnType<typeof renderScenario>> | null = null;
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await current?.cleanup();
  current = null;
  await app?.cleanup();
  app = undefined;
});

const audit = async () => {
  const results = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`
  );
};

describe("R2-T26 a11y", () => {
  it.each(SCENARIOS.map((scenario) => scenario.id))(
    "%s has no axe violations and named icon buttons",
    async (id) => {
      // Reply links need the router, so render them through the app.
      if (id.includes("-links")) app = await renderApp(`/__ui?fixture=${id}`);
      else current = await renderScenario(id);
      await waitFor(() =>
        expect(document.querySelector('[data-slot="chat-layout"]')).toBeTruthy()
      );
      expect(await audit()).toEqual([]);
      for (const button of document.querySelectorAll("button"))
        expect(
          button.getAttribute("aria-label") ?? button.textContent?.trim(),
          button.outerHTML.slice(0, 120)
        ).toBeTruthy();
      for (const card of document.querySelectorAll(
        '[data-slot="permission-card"]'
      ))
        expect(card.getAttribute("role")).toBe("group");
    }
  );

  it("tray chips are toggle buttons", async () => {
    current = await renderScenario("perm-two-pending");
    const chips = await screen.findAllByRole("button", { pressed: false });
    expect(chips.length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);
  });

  it("the status region announces a finished reply once", async () => {
    current = await renderScenario("session-running");
    vi.useFakeTimers();
    const region = document.querySelector('[data-slot="chat-announcer"]')!;
    act(() => {
      current!.fixture.relay.emitAll([
        b.toolResult("c4", { text: "ok" }),
        b.runFinished("r1"),
      ]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(region.textContent).toBe("");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(region.textContent).toBe("Reply finished");
    const writes: string[] = [];
    const observer = new MutationObserver(() =>
      writes.push(region.textContent ?? "")
    );
    observer.observe(region, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    act(() => current!.fixture.relay.emit(b.runFinished("r1")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    observer.disconnect();
    expect(writes).toEqual([]);
  });
});
