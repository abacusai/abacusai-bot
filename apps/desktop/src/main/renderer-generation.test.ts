/** R1-T17: the generation override is a development tool only. */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: true } }));

import {
  DEFAULT_RENDERER_GENERATION,
  RENDERER_GENERATION,
  resolveRendererGeneration,
} from "./renderer-generation";

describe("resolveRendererGeneration", () => {
  it("defaults to legacy", () => {
    expect(DEFAULT_RENDERER_GENERATION).toBe("legacy");
    expect(resolveRendererGeneration({}, false)).toBe("legacy");
    expect(resolveRendererGeneration({}, true)).toBe("legacy");
  });

  it("honours ABACUSBOT_RENDERER_GENERATION=wco only when unpackaged", () => {
    const env = { ABACUSBOT_RENDERER_GENERATION: "wco" };
    expect(resolveRendererGeneration(env, false)).toBe("wco");
    expect(resolveRendererGeneration(env, true)).toBe("legacy");
  });

  it("ignores any other value", () => {
    expect(
      resolveRendererGeneration(
        { ABACUSBOT_RENDERER_GENERATION: "next" },
        false
      )
    ).toBe("legacy");
  });

  it("is wco whatever the environment once the default says so", () => {
    expect(resolveRendererGeneration({}, true, "wco")).toBe("wco");
  });

  it("computes the process constant from the packaged flag", () => {
    // electron is mocked as packaged: the constant stays legacy.
    expect(RENDERER_GENERATION).toBe("legacy");
  });
});
