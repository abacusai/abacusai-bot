import { describe, expect, it } from "vitest";

import {
  LOCAL_MODEL_CATALOG,
  localModelReference,
  localModelUrl,
  recommendLocalModel,
} from "./local-models";

const GB = 1024 ** 3;

describe("which local model a machine is offered", () => {
  it("picks the largest model the memory allows", () => {
    expect(recommendLocalModel(64 * GB).id).toBe("qwen3.6-27b");
    expect(recommendLocalModel(32 * GB).id).toBe("qwen3.6-27b");
    expect(recommendLocalModel(16 * GB).id).toBe("qwen3.5-9b");
    expect(recommendLocalModel(12 * GB).id).toBe("qwen3.5-9b");
    expect(recommendLocalModel(8 * GB).id).toBe("qwen3.5-4b");
  });

  it("still offers the smallest model to a machine below every floor", () => {
    // A slow answer beats none; the dialog says the fit is tight.
    expect(recommendLocalModel(4 * GB).id).toBe("qwen3.5-4b");
  });
});

describe("the catalog's pins", () => {
  it("names every model by a file it can verify", () => {
    for (const spec of LOCAL_MODEL_CATALOG) {
      expect(spec.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(spec.sizeBytes).toBeGreaterThan(GB);
      expect(spec.file.endsWith(".gguf")).toBe(true);
      expect(localModelUrl(spec)).toBe(
        `https://huggingface.co/${spec.repo}/resolve/main/${spec.file}`
      );
    }
  });

  it("grows in memory need with size, so the recommendation is monotone", () => {
    const floors = LOCAL_MODEL_CATALOG.map((spec) => spec.minMemoryBytes);
    expect(floors).toEqual([...floors].sort((a, b) => a - b));
  });

  it("references models under the local provider", () => {
    expect(localModelReference("qwen3.5-4b")).toBe("local/qwen3.5-4b");
  });
});
