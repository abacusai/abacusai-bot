import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_BROWSER_HOMEPAGE,
  getBrowserHomepage,
  normalizeBrowserHomepage,
  setBrowserHomepage,
} from "./browser-homepage";

beforeEach(() => window.localStorage.clear());

describe("browser homepage", () => {
  it("defaults to Google", () => {
    expect(getBrowserHomepage()).toBe(DEFAULT_BROWSER_HOMEPAGE);
  });

  it("accepts a hostname without a scheme", () => {
    expect(normalizeBrowserHomepage("example.com")).toBe(
      "https://example.com/"
    );
  });

  it("only stores web URLs", () => {
    expect(setBrowserHomepage("javascript:alert(1)")).toBeNull();
    expect(getBrowserHomepage()).toBe(DEFAULT_BROWSER_HOMEPAGE);
  });
});
