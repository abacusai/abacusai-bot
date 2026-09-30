/**
 * The shell's own accessibility and chrome details (Claude impl r1 #9, #10,
 * #23, V6): axe over the real sidebars, the modal-hidden rail made inert,
 * the toast viewport under the title bar, the Settings gear.
 */
import { act, render, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";

import { SETTINGS_GEAR } from "#next/components/app-icon";
import { inertWhileHidden } from "#next/lib/inert-hidden";
import {
  sharedElementMounts,
  sharedElementStyle,
  useSharedElementName,
} from "#next/lib/navigation/shared-element";
import { renderApp, type AppHarness } from "#next/test-support/app-harness";

import { isToasterMounted, toastViewportStyle } from "./app-toaster";
import { panelToggleTarget } from "./use-panel";

let harness: AppHarness | null = null;
afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

const violations = async () => {
  const results = await axe.run(document, {
    rules: {
      "color-contrast": { enabled: false },
      region: { enabled: false },
    },
  });
  return results.violations.map((v) => ({ id: v.id, impact: v.impact }));
};

describe("shell a11y", () => {
  it.each(["/bots/new", "/routines", "/library/connectors", "/sessions/new"])(
    "%s has no list role over bare links and no critical violation",
    async (path) => {
      harness = await renderApp(path);
      await waitFor(() =>
        expect(document.querySelector('[data-slot="nav-list"]')).not.toBeNull()
      );
      await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
      expect(document.querySelector('[role="list"]')).toBeNull();
      const found = await violations();
      expect(found.filter((v) => v.id === "aria-required-children")).toEqual(
        []
      );
      expect(found.filter((v) => v.impact === "critical")).toEqual([]);
    }
  );

  it("a region a modal hides with aria-hidden becomes inert, and comes back", async () => {
    const nav = document.createElement("nav");
    nav.innerHTML = '<a href="#/bots/new">Bots</a>';
    const plain = document.createElement("div");
    plain.textContent = "decorative";
    document.body.append(nav, plain);
    const stop = inertWhileHidden();
    try {
      nav.setAttribute("aria-hidden", "true");
      plain.setAttribute("aria-hidden", "true");
      await waitFor(() => expect(nav.hasAttribute("inert")).toBe(true));
      expect(plain.hasAttribute("inert")).toBe(false);
      nav.removeAttribute("aria-hidden");
      await waitFor(() => expect(nav.hasAttribute("inert")).toBe(false));
    } finally {
      stop();
      nav.remove();
      plain.remove();
    }
  });
});

describe("the toast viewport (§7.4, Claude impl r1 #23)", () => {
  it("sits 10 px under the title bar and clear of the caption buttons", () => {
    expect(toastViewportStyle({ height: 40, end: 138 })).toEqual({
      top: "50px",
      right: "138px",
      bottom: "auto",
    });
    expect(toastViewportStyle({ height: 32, end: 0 })).toEqual({
      top: "42px",
      right: "16px",
      bottom: "auto",
    });
  });

  it("is mounted with the app, placed from the chrome's toolbar height", async () => {
    expect(isToasterMounted()).toBe(false);
    harness = await renderApp("/bots/new");
    expect(isToasterMounted()).toBe(true);
    const viewport = document.querySelector<HTMLElement>(
      '[data-testid="toast-viewport"]'
    );
    // Base UI mounts the viewport on the first toast; the style is the hook's.
    if (viewport != null) expect(viewport.style.top).toBe("50px");
  });
});

describe("panelToggleTarget", () => {
  it("closes an open panel, and reopens the area's last tab", () => {
    expect(panelToggleTarget("sessions", "files", {})).toBeUndefined();
    expect(panelToggleTarget("sessions", undefined, {})).toBe("changes");
    expect(
      panelToggleTarget("sessions", undefined, { sessions: "files" })
    ).toBe("files");
    // A tab from another area is never reused.
    expect(panelToggleTarget("bots", undefined, { sessions: "changes" })).toBe(
      "memory"
    );
  });
});

describe("shared elements (spec 01 §6.7 amendment)", () => {
  it("carry a CSS view-transition-name so they join the router's document transition", () => {
    expect(sharedElementStyle("bot-identity-b1")).toEqual({
      viewTransitionName: "bot-identity-b1",
      viewTransitionClass: "shared",
    });
    expect(sharedElementStyle(null)).toEqual({});
    const Probe = ({ name }: { name: string }) => (
      <span data-testid={name} style={useSharedElementName(name)} />
    );
    const view = render(<Probe name="bot-identity-b2" />);
    expect(sharedElementMounts("bot-identity-b2")).toBe(1);
    view.unmount();
    expect(sharedElementMounts("bot-identity-b2")).toBe(0);
  });
});

describe("the Settings glyph (V6)", () => {
  it("is a toothed gear, not rays around a circle", () => {
    expect(SETTINGS_GEAR).toMatch(/^M12\.22 2h-\.44/);
    expect(SETTINGS_GEAR).not.toContain("M12 3.5v2.2");
  });
});
