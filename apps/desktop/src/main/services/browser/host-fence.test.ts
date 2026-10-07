import { describe, expect, it } from "vitest";

import {
  FENCE_ERROR,
  fenceBlockPatterns,
  fenceGuardExpression,
  isFencedUrl,
  type HostFence,
} from "./host-fence";

const fence: HostFence = {
  exact: ["abacus.ai", "dev.example.test"],
  suffixes: [".abacus.ai"],
};

describe("the host fence", () => {
  it("covers every abacus.ai host and the configured ones", () => {
    expect(isFencedUrl("https://abacus.ai/app/vault/login?r=x", fence)).toBe(
      true
    );
    expect(isFencedUrl("https://apps.abacus.ai/api/anything", fence)).toBe(
      true
    );
    expect(isFencedUrl("abacus.ai/app/vault/card", fence)).toBe(true);
    expect(isFencedUrl("https://APPS.Abacus.AI./x", fence)).toBe(true);
    expect(isFencedUrl("https://dev.example.test/anything", fence)).toBe(true);
  });

  it("leaves other hosts alone", () => {
    expect(isFencedUrl("https://shop.example/app/vault/login", fence)).toBe(
      false
    );
    expect(isFencedUrl("https://abacus.ai.evil.example/app", fence)).toBe(
      false
    );
    expect(isFencedUrl("https://notabacus.ai/", fence)).toBe(false);
    expect(isFencedUrl(null, fence)).toBe(false);
  });

  it("blocks the same hosts the check covers", () => {
    expect(fenceBlockPatterns(fence)).toEqual([
      "*://abacus.ai/*",
      "*://dev.example.test/*",
      "*://*.abacus.ai/*",
    ]);
  });

  it("stops a page script on a fenced document, in the same evaluation", () => {
    const guard = (hostname: string): void => {
      const run = new Function(
        "location",
        `return ${fenceGuardExpression(fence)};`
      ) as (location: { hostname: string }) => void;
      run({ hostname });
    };

    expect(() => guard("apps.abacus.ai")).toThrow(FENCE_ERROR);
    expect(() => guard("abacus.ai.")).toThrow(FENCE_ERROR);
    expect(() => guard("shop.example")).not.toThrow();
    expect(() => guard("")).not.toThrow();
  });
});
