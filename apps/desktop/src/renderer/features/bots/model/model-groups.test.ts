/**
 * R3-T24 (pure half): the bot model picker's groups keep the old composer
 * picker's order and rules, App default leads with the resolved default's
 * label, and display resolves through `resolveConfiguredModel`.
 */
import { describe, expect, it, vi } from "vitest";

import type { ModelAvailability } from "#shared/models";

import {
  APP_DEFAULT_ITEM_ID,
  appDefaultLabel,
  botModelGroups,
  effectiveModelLabel,
  modelSearchText,
  toggleFavorite,
  type BotModelLabels,
} from "./model-groups";

const labels: BotModelLabels = {
  defaultGroup: "Default",
  appDefault: "App default",
  favorites: "Favorites",
  localProvider: "On this machine",
  connectOpenRouter: "Connect OpenRouter",
  connectGoogleAi: "Connect Google AI Studio",
  tierFree: "Free",
  tierLocal: "Local",
};

const model = (
  id: string,
  provider: string,
  patch: Partial<ModelAvailability> = {}
): ModelAvailability => ({
  id,
  label: id.split("/").at(-1)!,
  provider,
  tier: "fast",
  configured: true,
  ...patch,
});

const catalog: ModelAvailability[] = [
  model("abacus/route-llm", "abacus", { label: "RouteLLM", recommended: true }),
  model("openllm/auto", "openllm", { label: "RouteLLM - Open", tier: "free" }),
  model("zai/glm", "zai", { label: "GLM" }),
  model("deepseek/deepseek-v4-flash", "deepseek", { label: "V4 Flash" }),
  model("deepseek/deepseek-r2", "deepseek", {
    label: "R2",
    note: "reasoning",
  }),
  model("gemini/flash", "gemini", { label: "Gemini Flash" }),
  model("openrouter/x", "openrouter", { label: "X", tier: "free" }),
  model("anthropic/opus", "anthropic", { label: "Opus", configured: false }),
  model("local/llama", "local", { label: "Llama", tier: "local" }),
];

const groups = (patch: Partial<Parameters<typeof botModelGroups>[0]> = {}) =>
  botModelGroups({
    models: catalog,
    favorites: [],
    defaultModel: null,
    freeTier: false,
    labels,
    onConnect: () => undefined,
    ...patch,
  });

describe("botModelGroups", () => {
  it("leads with App default, labelled with the resolved default", () => {
    const [first] = groups({ defaultModel: "zai/glm" });
    expect(first).toEqual({
      id: "default",
      label: "Default",
      items: [
        { id: APP_DEFAULT_ITEM_ID, label: "App default", description: "GLM" },
      ],
    });
  });

  it("orders providers Abacus, OpenRouter, Gemini, then alphabetically; configured only", () => {
    expect(groups().map((group) => group.id)).toEqual([
      "default",
      "abacus",
      "openrouter",
      "gemini",
      "deepseek",
      "local",
      "zai",
    ]);
    expect(
      groups().flatMap((group) => group.items.map((i) => i.id))
    ).not.toContain("anthropic/opus");
    expect(groups().find((group) => group.id === "local")?.label).toBe(
      "On this machine"
    );
    expect(groups().find((group) => group.id === "gemini")?.label).toBe(
      "Google Gemini (AI Studio)"
    );
  });

  it("puts OpenLLM first in the Abacus group and badges free/local tiers", () => {
    const abacus = groups().find((group) => group.id === "abacus")!;
    expect(abacus.items).toEqual([
      { id: "openllm/auto", label: "RouteLLM - Open", description: "Free" },
      { id: "abacus/route-llm", label: "RouteLLM" },
    ]);
  });

  it("adds a Favorites group (configured only) and floats favourites in their provider", () => {
    const result = groups({
      favorites: ["deepseek/deepseek-v4-flash", "anthropic/opus"],
    });
    expect(result[1]).toEqual({
      id: "favorites",
      label: "Favorites",
      items: [{ id: "deepseek/deepseek-v4-flash", label: "V4 Flash" }],
    });
    expect(
      result.find((group) => group.id === "deepseek")!.items.map((i) => i.id)
    ).toEqual(["deepseek/deepseek-v4-flash", "deepseek/deepseek-r2"]);
  });

  it("offers connect rows for unconfigured free providers on the free plan", () => {
    const onConnect = vi.fn();
    const models = catalog.filter(
      (entry) => entry.provider !== "openrouter" && entry.provider !== "gemini"
    );
    const result = groups({ models, freeTier: true, onConnect });
    const openrouter = result.find((group) => group.id === "openrouter")!;
    expect(openrouter.items).toEqual([]);
    expect(openrouter.connect?.label).toBe("Connect OpenRouter");
    openrouter.connect!.onSelect();
    result.find((group) => group.id === "gemini")!.connect!.onSelect();
    expect(onConnect.mock.calls).toEqual([["openrouter"], ["gemini"]]);
    // Not on a paid plan, and not once connected.
    expect(
      groups({ models }).find((group) => group.id === "openrouter")
    ).toBeUndefined();
    expect(
      groups({ freeTier: true }).find((group) => group.id === "openrouter")
        ?.connect
    ).toBeUndefined();
  });

  it("searches label, id, provider name and note", () => {
    const ids = (query: string) =>
      groups({ query })
        .filter((group) => group.id !== "default")
        .flatMap((group) => group.items.map((item) => item.id));
    expect(ids("reasoning")).toEqual(["deepseek/deepseek-r2"]);
    expect(ids("zai/")).toEqual(["zai/glm"]);
    expect(ids("deepseek")).toEqual([
      "deepseek/deepseek-r2",
      "deepseek/deepseek-v4-flash",
    ]);
    expect(ids("abacus.ai")).toEqual(["openllm/auto", "abacus/route-llm"]);
    expect(modelSearchText(catalog[2]!, "x")).toContain("z.ai");
  });
});

describe("the one resolver for display", () => {
  it("shows the bot's model when configured, else resolves like main", () => {
    expect(effectiveModelLabel("zai/glm", null, catalog)).toBe("GLM");
    // A stored model without credentials falls through to the default…
    expect(effectiveModelLabel("anthropic/opus", "zai/glm", catalog)).toBe(
      "GLM"
    );
    // …and an unconfigured default to the recommended one.
    expect(appDefaultLabel("anthropic/opus", catalog)).toBe("RouteLLM");
    expect(appDefaultLabel(null, [])).toBeNull();
  });

  it("toggles favourites", () => {
    expect(toggleFavorite(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleFavorite(["a", "b"], "a")).toEqual(["b"]);
  });
});
