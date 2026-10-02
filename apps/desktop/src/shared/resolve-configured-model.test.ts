import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_ID,
  resolveConfiguredModel,
  type ModelAvailability,
} from "./models";

const entry = (
  id: string,
  configured: boolean,
  recommended = false
): ModelAvailability => ({
  id,
  label: id,
  provider: id.split("/")[0]!,
  tier: "default",
  configured,
  ...(recommended && { recommended: true }),
});

describe("resolveConfiguredModel (spec 03 §13.2)", () => {
  const catalog = [
    entry("a/one", true),
    entry("b/two", true, true),
    entry(DEFAULT_MODEL_ID, true),
    entry("c/locked", false),
  ];

  it("takes, in order: requested, stored default, recommendation, DEFAULT_MODEL_ID, first configured", () => {
    expect(
      resolveConfiguredModel({
        requested: "a/one",
        defaultModel: "b/two",
        catalog,
      })
    ).toBe("a/one");
    expect(
      resolveConfiguredModel({
        requested: null,
        defaultModel: "a/one",
        catalog,
      })
    ).toBe("a/one");
    expect(
      resolveConfiguredModel({ requested: null, defaultModel: null, catalog })
    ).toBe("b/two");
    expect(
      resolveConfiguredModel({
        requested: null,
        defaultModel: null,
        catalog: catalog.filter((model) => model.id !== "b/two"),
      })
    ).toBe(DEFAULT_MODEL_ID);
    expect(
      resolveConfiguredModel({
        requested: null,
        defaultModel: null,
        catalog: [entry("z/last", false), entry("y/first", true)],
      })
    ).toBe("y/first");
  });

  it("never returns an unconfigured or unknown id, and null when nothing runs", () => {
    expect(
      resolveConfiguredModel({
        requested: "c/locked",
        defaultModel: "gone/x",
        catalog,
      })
    ).toBe("b/two");
    expect(
      resolveConfiguredModel({
        requested: "a/one",
        defaultModel: null,
        catalog: [entry("a/one", false)],
      })
    ).toBeNull();
    expect(
      resolveConfiguredModel({ requested: "", defaultModel: "", catalog: [] })
    ).toBeNull();
  });
});
