import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Isolated fake credential and account endpoints for desktop test homes.
 * @param {string} home
 * @returns {string} The Node preload that intercepts account requests.
 */
export const authenticatedTestHome = (home) => {
  const configPath = join(home, "config.json");
  const config = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8"))
    : {};
  config.apiKeys = {
    ...config.apiKeys,
    ABACUS_API_KEY: "acceptance-invalid-key",
  };
  writeFileSync(configPath, JSON.stringify(config));
  const preload = join(home, "fake-abacus.cjs");
  writeFileSync(
    preload,
    `
const realFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
  if (url.hostname === "abacus.ai" || url.hostname.endsWith(".abacus.ai")) {
    const body = url.pathname === "/v1/account"
      ? { id: "acceptance-account", name: "Acceptance", email: "acceptance@example.test", subscription_tier: "free", credits_granted: 100, credits_used: 0 }
      : { data: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: url.pathname === "/v1/account" || url.pathname === "/v1/models" ? 200 : 503, headers: { "content-type": "application/json" } }));
  }
  return realFetch(input, options);
};
`
  );
  return preload;
};
