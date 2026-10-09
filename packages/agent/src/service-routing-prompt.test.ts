import { describe, expect, it } from "vitest";

import { serviceRoutingPrompt } from "./service-routing-prompt.js";
import { PHONE_CONNECTABLE_SERVICES } from "./tool-policy.js";

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

  it("offers the phone only Google and GitHub to connect, and still routes to what is connected", () => {
    const text = serviceRoutingPrompt(PHONE_CONNECTABLE_SERVICES);
    expect(text).toContain(
      "From this chat the user can connect only Gmail, Google Drive, Google Calendar, GitHub."
    );
    expect(text).toMatch(/Slack messages and channels → Slack/);
    expect(text).toContain(
      "call connect_connector with its name, and follow its answer"
    );
    expect(text).not.toMatch(/connectors this app can attach|tool servers/);
    expect(text).not.toContain("Never say a name");
  });
});
