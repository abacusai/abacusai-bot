import { expect, it, vi } from "vitest";
vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "1.0.0" },
}));
import { abacusAppHost } from "./abacus-host";
it("packaged desktop ignores host mode and endpoint environment overrides", () => {
  vi.stubEnv("ABACUSAI_BOT_HOST_MODE", "1");
  vi.stubEnv("ABACUSAI_BOT_ABACUS_HOST", "https://apps-preprod.abacus.ai");
  try {
    expect(abacusAppHost()).toBe("https://apps.abacus.ai");
  } finally {
    vi.unstubAllEnvs();
  }
});
