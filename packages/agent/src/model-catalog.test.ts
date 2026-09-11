/**
 * The bundled catalog is a snapshot; the supplement carries what shipped
 * after it. A supplement must show up exactly once, and must stop being
 * "missing" the moment pi's own data carries it.
 */
import { describe, expect, it } from "vitest";

import {
  CATALOG_SUPPLEMENTS,
  listBuiltinModels,
  missingCatalogSupplements,
} from "./model-catalog.js";

describe("catalog supplements", () => {
  it("lists Fable 5.1 under anthropic once, with the vendor's name", () => {
    const models = listBuiltinModels(["anthropic"]);
    const fable = models.filter((m) => m.id === "anthropic/claude-fable-5-1");
    expect(fable).toHaveLength(1);
    expect(fable[0]?.label).toBe("Claude Fable 5.1");
    expect(fable[0]?.free).toBe(false);
    expect(fable[0]?.contextWindow).toBe(1_000_000);
  });

  it("never duplicates a model the bundled data already carries", () => {
    const models = listBuiltinModels(["anthropic"]);
    const ids = models.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Fable 5 is bundled: still one row, not one per source.
    expect(ids.filter((id) => id === "anthropic/claude-fable-5")).toHaveLength(
      1
    );
  });

  it("reports only the supplements the bundled data lacks", () => {
    const missing = missingCatalogSupplements();
    for (const [provider, models] of Object.entries(missing)) {
      const bundled = new Set(
        listBuiltinModels([provider]).map((m) =>
          m.id.slice(provider.length + 1)
        )
      );
      const supplemented = new Set(
        (CATALOG_SUPPLEMENTS[provider] ?? []).map((m) => m.id)
      );
      for (const model of models) {
        expect(supplemented.has(model.id)).toBe(true);
        expect(bundled.has(model.id)).toBe(true);
      }
    }
  });
});
