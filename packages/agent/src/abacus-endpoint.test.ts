import { describe, expect, it } from "vitest";

import { DEFAULT_ABACUS_V1, abacusV1BaseUrl } from "./abacus-endpoint.js";

const at = (value?: string): string =>
  abacusV1BaseUrl({ ABACUSAI_BOT_ABACUS_V1: value } as NodeJS.ProcessEnv);

describe("abacusV1BaseUrl", () => {
  it("defaults to production when unset or blank", () => {
    expect(abacusV1BaseUrl({} as NodeJS.ProcessEnv)).toBe(DEFAULT_ABACUS_V1);
    expect(at("")).toBe(DEFAULT_ABACUS_V1);
    expect(at("   ")).toBe(DEFAULT_ABACUS_V1);
  });

  it("honors an https abacus.ai override", () => {
    expect(at("https://routellm.abacus.ai/v1")).toBe(
      "https://routellm.abacus.ai/v1"
    );
    expect(at("https://staging.abacus.ai/v1")).toBe(
      "https://staging.abacus.ai/v1"
    );
    expect(at("https://abacus.ai/v1")).toBe("https://abacus.ai/v1");
  });

  it("falls back to production for a non-abacus host", () => {
    expect(at("https://attacker.example/v1")).toBe(DEFAULT_ABACUS_V1);
    expect(at("https://abacus.ai.evil.com/v1")).toBe(DEFAULT_ABACUS_V1);
    expect(at("https://notabacus.ai/v1")).toBe(DEFAULT_ABACUS_V1);
  });

  it.each([undefined, "", "0", "true", " 1", "1 "])(
    "rejects dev pods without exact opt-in (%s)",
    (flag) => {
      expect(
        abacusV1BaseUrl({
          ABACUSAI_BOT_ABACUS_V1:
            "https://rajaniraiyn-dev.mumbai.internalreai.com/v1",
          ABACUSAI_BOT_DEV_ENDPOINTS: flag,
        })
      ).toBe(DEFAULT_ABACUS_V1);
    }
  );

  it("accepts an https dev pod with explicit opt-in", () => {
    const url = "https://rajaniraiyn-dev.mumbai.internalreai.com/v1";
    expect(
      abacusV1BaseUrl({
        ABACUSAI_BOT_ABACUS_V1: url,
        ABACUSAI_BOT_DEV_ENDPOINTS: "1",
      })
    ).toBe(url);
  });

  it.each([
    "http://pod.internalreai.com/v1",
    "https://internalreai.com/v1",
    "https://notinternalreai.com/v1",
    "https://pod.internalreai.com.evil.com/v1",
    "https://attacker.example/v1",
    "not a URL",
  ])("rejects %s even with dev opt-in", (url) => {
    expect(
      abacusV1BaseUrl({
        ABACUSAI_BOT_ABACUS_V1: url,
        ABACUSAI_BOT_DEV_ENDPOINTS: "1",
      })
    ).toBe(DEFAULT_ABACUS_V1);
  });

  it("falls back to production for non-https or a malformed URL", () => {
    expect(at("http://routellm.abacus.ai/v1")).toBe(DEFAULT_ABACUS_V1);
    expect(at("ftp://abacus.ai/v1")).toBe(DEFAULT_ABACUS_V1);
    expect(at("not a url")).toBe(DEFAULT_ABACUS_V1);
  });
});
