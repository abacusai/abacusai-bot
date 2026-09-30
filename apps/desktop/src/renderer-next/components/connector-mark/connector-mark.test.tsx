/** Spec 03 §15: the 26 canvas marks, platform/provider mapping, geometry. */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  CONNECTOR_MARK_IDS,
  ConnectorMark,
  markForPlatform,
  markForProvider,
} from ".";

describe("ConnectorMark", () => {
  it("draws all 26 marks with the canvas geometry", () => {
    expect(CONNECTOR_MARK_IDS).toHaveLength(26);
    for (const id of CONNECTOR_MARK_IDS) {
      const { container, unmount } = render(
        <ConnectorMark id={id} size={28} />
      );
      const tile = container.firstElementChild as HTMLElement;
      expect(tile.dataset.mark).toBe(id);
      expect(tile.style.borderRadius).toBe("8px");
      expect(tile.querySelector("svg")?.getAttribute("width")).toBe("19");
      expect(tile.querySelectorAll("path").length).toBeGreaterThan(0);
      expect(tile.getAttribute("aria-hidden")).toBe("true");
      unmount();
    }
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
