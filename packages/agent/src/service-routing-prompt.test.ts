import { describe, expect, it } from "vitest";

import { serviceRoutingPrompt } from "./service-routing-prompt.js";

describe("serviceRoutingPrompt", () => {
  it("is the registry's routing line: gh as the user once GitHub is connected, Gmail for mail, connect before browsing", () => {
    const text = serviceRoutingPrompt();
    expect(text).toMatch(/pull requests.*`gh` and git in bash/);
    expect(text).toMatch(/signed in as the user once GitHub is connected/);
    expect(text).toMatch(/mail → Gmail/);
    expect(text).toMatch(/Google Calendar/);
    expect(text).toMatch(/connect_connector rather than/);
    expect(text).not.toMatch(/GitHub connector;/);
  });

  it("is static, so it never costs the prompt cache", () => {
    expect(serviceRoutingPrompt()).toBe(serviceRoutingPrompt());
    expect(serviceRoutingPrompt()).not.toMatch(/\d{4}/);
  });
});
