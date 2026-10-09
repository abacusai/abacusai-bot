import { afterEach, expect, it, vi } from "vitest";

import { webHostPrompt } from "./web-host-prompt.js";

afterEach(() => vi.unstubAllEnvs());

it("explains remote preview access for web-hosted sessions", () => {
  vi.stubEnv("ABACUSAI_BOT_CLIENT_KIND", "web_host");
  expect(webHostPrompt()).toContain("remote VM");
  expect(webHostPrompt()).toContain("Never tell the user");
  expect(webHostPrompt()).toContain("HTML file");
  expect(webHostPrompt()).toContain("verify the resulting public URL");
});

it.each([undefined, "desktop_code_mode"])(
  "keeps local sessions unchanged for %s",
  (kind) => {
    vi.stubEnv("ABACUSAI_BOT_CLIENT_KIND", kind);
    expect(webHostPrompt()).toBeNull();
  }
);
