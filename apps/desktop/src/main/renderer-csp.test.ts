import { describe, expect, it } from "vitest";

import { RENDERER_CSP, rendererCspHeaders } from "./renderer-csp";

describe("rendererCspHeaders", () => {
  it("sets the CSP header on an app:// main-frame document", () => {
    const headers = rendererCspHeaders({
      resourceType: "mainFrame",
      url: "app://renderer/index.html",
      responseHeaders: { "content-type": ["text/html"] },
    });

    expect(headers?.["Content-Security-Policy"]).toEqual([RENDERER_CSP]);
    expect(headers?.["content-type"]).toEqual(["text/html"]);
  });

  it("replaces any CSP the response already carried, case-insensitively", () => {
    const headers = rendererCspHeaders({
      resourceType: "mainFrame",
      url: "app://renderer/index.html",
      responseHeaders: { "Content-Security-Policy": ["default-src *"] },
    });

    expect(headers?.["Content-Security-Policy"]).toEqual([RENDERER_CSP]);
    const cspKeys = Object.keys(headers ?? {}).filter(
      (key) => key.toLowerCase() === "content-security-policy"
    );
    expect(cspKeys).toEqual(["Content-Security-Policy"]);
  });

  it("leaves connector / browser (https) responses untouched", () => {
    const original = { "content-type": ["text/html"] };
    const headers = rendererCspHeaders({
      resourceType: "mainFrame",
      url: "https://web.whatsapp.com/",
      responseHeaders: original,
    });

    expect(headers).toBe(original);
  });

  it("leaves the visualizer guest (data:) untouched", () => {
    const headers = rendererCspHeaders({
      resourceType: "mainFrame",
      url: "data:text/html;charset=utf-8,%3Chtml%3E",
      responseHeaders: undefined,
    });

    expect(headers).toBeUndefined();
  });

  it("does not touch app:// subresources, which the top document's CSP covers", () => {
    const original = { "content-type": ["application/javascript"] };
    const headers = rendererCspHeaders({
      resourceType: "script",
      url: "app://renderer/assets/index.js",
      responseHeaders: original,
    });

    expect(headers).toBe(original);
  });
});
