/** Settings → Usage: credits against the allowance, one window, real model names. */
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it } from "vitest";

import enUS from "#locales/en-US.json";
import { i18n, initI18n } from "#renderer/lib/i18n";

import { usageModelName } from "./usage";
import { UsageGallery } from "./usage-gallery";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en-US");
});

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

it.each([
  ["deepseek-ai/DeepSeek-V4.1-Flash-1017", "DeepSeek V4.1 Flash"],
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["gpt-6.1-sol-20261001", "GPT 6.1 Sol"],
  ["qwen/qwen3.5-coder:free", "Qwen3.5 Coder"],
  ["deepseek-v4-flash", "DeepSeek V4 Flash"],
])("names the served model %s as %s", (modelId, name) => {
  expect(usageModelName({ id: `x/${modelId}`, modelId }, [])).toBe(name);
});

it("prefers the catalog's label", () => {
  expect(
    usageModelName(
      { id: "abacus/route-llm-code-low", modelId: "route-llm-code-low" },
      [{ id: "abacus/route-llm-code-low", label: "RouteLLM" }]
    )
  ).toBe("RouteLLM");
});

it("shows a free account's credits against its grant, and no provider it lacks", () => {
  unmount = render(<UsageGallery fixture="usage-free" />).unmount;
  const meter = screen.getByRole("meter");
  expect(meter.getAttribute("aria-valuenow")).toBe("72.6");
  expect(meter.getAttribute("aria-valuemax")).toBe("2000");
  expect(screen.getByText("Expires Dec 3")).toBeDefined();
  expect(screen.getByText("DeepSeek V4.1 Flash")).toBeDefined();
  // No OpenRouter key: no OpenRouter anything, and no dollars on Abacus.AI rows.
  expect(screen.queryByText(enUS.phase5.openrouterBrand)).toBeNull();
  expect(document.body.textContent).not.toContain("$");
  // The summary, the chart and the models share the snapshot's one window.
  expect(screen.getAllByText("Last 30 days")).toHaveLength(2);
});

it("shows a paid plan's reset date and its own-key provider", () => {
  unmount = render(<UsageGallery fixture="usage-paid" />).unmount;
  expect(screen.getByText("Resets Dec 3")).toBeDefined();
  const keys = document.querySelector('[data-setting-id="usageKeys"]');
  expect(keys).not.toBeNull();
  expect(
    within(keys as HTMLElement).getByText(enUS.phase5.openrouterBrand)
  ).toBeDefined();
  expect(screen.getByText(/\$1\.84/u)).toBeDefined();
});
