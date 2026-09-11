import { describe, expect, it } from "vitest";

import { serviceRoutingPrompt } from "./service-routing-prompt.js";

describe("serviceRoutingPrompt", () => {
  it("sends repository work to GitHub and says to connect before browsing", () => {
    const text = serviceRoutingPrompt();
    expect(text).toMatch(/pull requests.*GitHub connector/);
    expect(text).toMatch(/mail → Gmail/);
    expect(text).toMatch(/Calendar/);
    expect(text).toMatch(/connect_connector rather than/);
  });

  it("is static, so it never costs the prompt cache", () => {
    expect(serviceRoutingPrompt()).toBe(serviceRoutingPrompt());
    expect(serviceRoutingPrompt()).not.toMatch(/\d{4}/);
  });
});
