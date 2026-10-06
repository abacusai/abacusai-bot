/**
 * Spec 03 §15: every canvas mark and every registry connector draws a real
 * glyph on the same neutral tile; platform/provider mapping; geometry.
 */
import { CONNECTORS } from "@abacus-ai/connectors/registry";
import { LOCAL_PROVIDER_ID } from "@abacus-ai/contract/local-models";
import { PROVIDER_KEY_FIELDS } from "@abacus-ai/contract/settings";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  CONNECTOR_MARK_IDS,
  ConnectorMark,
  markForPlatform,
  markForProvider,
} from ".";

/** Providers the catalog or the agent name beyond the key fields. */
const OTHER_PROVIDERS = [
  LOCAL_PROVIDER_ID,
  "openllm",
  "routellm",
  "openai-codex",
  "vercel-ai-gateway",
  "huggingface",
  "moonshotai",
];

describe("ConnectorMark", () => {
  it("draws all 56 marks with the canvas geometry on the neutral tile", () => {
    expect(CONNECTOR_MARK_IDS).toHaveLength(56);
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

  it("gives every model provider a mark that draws a real glyph", () => {
    const providers = [
      ...PROVIDER_KEY_FIELDS.filter((field) => field.kind === "model").map(
        (field) => field.provider
      ),
      ...OTHER_PROVIDERS,
    ];
    expect(providers.length).toBeGreaterThan(20);
    const missing: string[] = [];
    for (const provider of providers) {
      const mark = markForProvider(provider);
      if (mark == null) {
        missing.push(provider);
        continue;
      }
      const { container, unmount } = render(
        <ConnectorMark id={mark} size={28} />
      );
      const tile = container.firstElementChild as HTMLElement;
      if (tile.dataset.mark !== mark) missing.push(provider);
      unmount();
    }
    expect(missing).toEqual([]);
  });

  it("falls back to a neutral tile with the initial, and takes a label", () => {
    const { container } = render(
      <ConnectorMark id="nowhere" size={16} label="Nowhere" />
    );
    const tile = container.firstElementChild as HTMLElement;
    expect(tile.dataset.mark).toBe("neutral");
    expect(tile.textContent).toBe("N");
    expect(tile.getAttribute("role")).toBe("img");
    expect(tile.getAttribute("aria-label")).toBe("Nowhere");
  });

  it("maps platforms (shared twins included) and providers", () => {
    expect(markForPlatform("whatsapp")).toBe("whatsapp");
    expect(markForPlatform("abacus_telegram")).toBe("telegram");
    expect(markForPlatform("abacus_discord")).toBe("discord");
    expect(markForPlatform("sms")).toBeNull();
    expect(markForProvider("openllm")).toBe("abacus");
    expect(markForProvider("abacus")).toBe("abacus");
    expect(markForProvider("openrouter")).toBe("openrouter");
    expect(markForProvider("gemini")).toBe("gemini");
    expect(markForProvider("Anthropic")).toBe("anthropic");
    expect(markForProvider("nowhere")).toBeNull();
  });
});
