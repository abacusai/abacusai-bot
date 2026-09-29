import { afterEach, describe, expect, it } from "vitest";

import { nativeT, setNativeLanguage } from "./native-i18n";

afterEach(() => setNativeLanguage("en-US"));
describe("native UI translations", () => {
  it("uses the selected app language independently of the renderer", () => {
    setNativeLanguage("de-DE");
    expect(nativeT("quit")).toBe("Beenden");
    expect(nativeT("hideApp", { app: "AbacusAI Bot" })).toContain(
      "AbacusAI Bot"
    );
    expect(nativeT("hideApp", { app: "AbacusAI Bot" })).not.toContain("{{");
    setNativeLanguage("ja-JP");
    expect(nativeT("quit")).toBe("終了");
  });
  it("falls back to English for an unsupported native language", () => {
    setNativeLanguage("zz-ZZ");
    expect(nativeT("quit")).toBe("Quit");
  });
});
