import { afterEach, describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({
  isPackaged: true,
  getVersion: vi.fn(() => "1.0.0"),
}));
vi.mock("electron", () => ({ app }));
import {
  abacusAppHost,
  abacusRoutellmV1,
  isHostOverridden,
} from "./abacus-host";

afterEach(() => {
  vi.unstubAllEnvs();
  app.isPackaged = true;
  app.getVersion.mockReturnValue("1.0.0");
});

const devHost = "https://pod.dev.example.test";

it.each(["https://apps-preprod.abacus.ai", devHost])(
  "packaged desktop ignores host mode and endpoint overrides: %s",
  (host) => {
    vi.stubEnv("ABACUSAI_BOT_HOST_MODE", "1");
    vi.stubEnv("ABACUSAI_BOT_DEV_ENDPOINTS", "1");
    vi.stubEnv("ABACUSAI_BOT_DEV_ENDPOINT_SUFFIX", ".dev.example.test");
    vi.stubEnv("ABACUSAI_BOT_ABACUS_HOST", host);
    expect(abacusAppHost()).toBe("https://apps.abacus.ai");
    expect(abacusRoutellmV1()).toBe("https://routellm.abacus.ai/v1");
    expect(isHostOverridden()).toBe(false);
  }
);

describe.each([false, true])("dev hosts (packaged: %s)", (packaged) => {
  it("uses the configured suffix without requiring the agent opt-in", () => {
    app.isPackaged = packaged;
    if (packaged) app.getVersion.mockReturnValue("1.0.0-test.123");
    vi.stubEnv("ABACUSAI_BOT_DEV_ENDPOINTS", undefined);
    vi.stubEnv("ABACUSAI_BOT_DEV_ENDPOINT_SUFFIX", ".OTHER.example.test");
    vi.stubEnv("ABACUSAI_BOT_ABACUS_HOST", "https://pod.other.example.test");
    expect(abacusAppHost()).toBe("https://pod.other.example.test");
    expect(abacusRoutellmV1()).toBe("https://pod.other.example.test/v1");
    vi.stubEnv("ABACUSAI_BOT_ABACUS_HOST", devHost);
    expect(isHostOverridden()).toBe(false);
  });

  it.each([devHost, "https://apps-preprod.abacus.ai"])(
    "accepts %s in unpackaged or test builds",
    (host) => {
      app.isPackaged = packaged;
      if (packaged) app.getVersion.mockReturnValue("1.0.0-test.123");
      vi.stubEnv("ABACUSAI_BOT_DEV_ENDPOINT_SUFFIX", ".dev.example.test");
      vi.stubEnv("ABACUSAI_BOT_ABACUS_HOST", host);
      expect(abacusAppHost()).toBe(host);
      expect(isHostOverridden()).toBe(true);
      expect(abacusRoutellmV1()).toBe(
        host === devHost
          ? `${devHost}/v1`
          : "https://routellm-preprod.abacus.ai/v1"
      );
    }
  );

  it.each([
    "http://pod.dev.example.test",
    "https://dev.example.test",
    "https://notdev.example.test",
    "https://pod.dev.example.test.evil.com",
    "https://attacker.example",
    "not a URL",
  ])("rejects %s", (host) => {
    app.isPackaged = packaged;
    if (packaged) app.getVersion.mockReturnValue("1.0.0-test.123");
    vi.stubEnv("ABACUSAI_BOT_DEV_ENDPOINT_SUFFIX", ".dev.example.test");
    vi.stubEnv("ABACUSAI_BOT_ABACUS_HOST", host);
    expect(abacusAppHost()).toBe("https://apps.abacus.ai");
    expect(isHostOverridden()).toBe(false);
  });

  it.each([
    undefined,
    "",
    "dev.example.test",
    ".",
    " .dev.example.test",
    ".dev.example.test ",
    ".dev.example.test,.other.test",
    ".dev.example.test/path",
    ".dev..example.test",
    ".-dev.example.test",
  ])("rejects a missing or malformed dev suffix (%s)", (suffix) => {
    app.isPackaged = packaged;
    if (packaged) app.getVersion.mockReturnValue("1.0.0-test.123");
    vi.stubEnv("ABACUSAI_BOT_DEV_ENDPOINT_SUFFIX", suffix);
    vi.stubEnv("ABACUSAI_BOT_ABACUS_HOST", devHost);
    expect(abacusAppHost()).toBe("https://apps.abacus.ai");
    expect(abacusRoutellmV1()).toBe("https://routellm.abacus.ai/v1");
    expect(isHostOverridden()).toBe(false);
  });
});

it("does not treat a different prerelease version as a test build", () => {
  app.getVersion.mockReturnValue("1.0.0-beta.1");
  vi.stubEnv("ABACUSAI_BOT_DEV_ENDPOINT_SUFFIX", ".dev.example.test");
  vi.stubEnv("ABACUSAI_BOT_ABACUS_HOST", devHost);
  expect(abacusAppHost()).toBe("https://apps.abacus.ai");
});
