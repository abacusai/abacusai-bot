/**
 * Spec 03 §15: every canvas mark and every registry connector draws a real
 * glyph on the same neutral tile; platform/provider mapping; geometry.
 */
import { CONNECTORS } from "@abacus-ai/connectors/registry";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  CONNECTOR_MARK_IDS,
  ConnectorMark,
  markForPlatform,
  markForProvider,
} from ".";

describe("ConnectorMark", () => {
  it("draws all 39 marks with the canvas geometry on the neutral tile", () => {
    expect(CONNECTOR_MARK_IDS).toHaveLength(39);
    for (const id of CONNECTOR_MARK_IDS) {
      const { container, unmount } = render(
        <ConnectorMark id={id} size={28} />
      );
      const tile = container.firstElementChild as HTMLElement;
      expect(tile.dataset.mark).toBe(id);
      expect(tile.style.borderRadius).toBe("8px");
      expect(tile.style.background).toBe("");
      expect(tile.className).toContain("bg-muted");
      expect(tile.className).not.toContain("ring-");
      expect(tile.querySelector("svg")?.getAttribute("width")).toBe("22");
      expect(tile.querySelectorAll("path").length).toBeGreaterThan(0);
      expect(tile.getAttribute("aria-hidden")).toBe("true");
      unmount();
    }
  });

  it("gives every connector in the registry a real mark, by logo or id", () => {
    const neutral: string[] = [];
    for (const connector of CONNECTORS) {
      const id = connector.logo ?? connector.id;
      const { container, unmount } = render(
        <ConnectorMark id={id} size={28} />
      );
      const tile = container.firstElementChild as HTMLElement;
      if (tile.dataset.mark === "neutral") neutral.push(connector.id);
      unmount();
    }
    expect(neutral).toEqual([]);
  });

  it("falls back to a neutral tile with the initial, and takes a label", () => {
    const { container } = render(
      <ConnectorMark id="gemini" size={16} label="Gemini" />
    );
    const tile = container.firstElementChild as HTMLElement;
    expect(tile.dataset.mark).toBe("neutral");
    expect(tile.textContent).toBe("G");
    expect(tile.getAttribute("role")).toBe("img");
    expect(tile.getAttribute("aria-label")).toBe("Gemini");
  });

  it("maps platforms (shared twins included) and providers", () => {
    expect(markForPlatform("whatsapp")).toBe("whatsapp");
    expect(markForPlatform("abacus_telegram")).toBe("telegram");
    expect(markForPlatform("abacus_discord")).toBe("discord");
    expect(markForPlatform("sms")).toBeNull();
    expect(markForProvider("openllm")).toBe("abacus");
    expect(markForProvider("abacus")).toBe("abacus");
    expect(markForProvider("openrouter")).toBe("openrouter");
    expect(markForProvider("gemini")).toBeNull();
  });
});
