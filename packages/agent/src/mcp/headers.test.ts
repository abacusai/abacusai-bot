/**
 * Which header placeholders expand, and where the result may be sent.
 *
 * The expansion exists for one entry (the Abacus connector gateway), but every
 * server entry goes through it, including entries imported from another
 * tool's config or typed into mcp-code.json by hand.
 */
import { describe, expect, it } from "vitest";

import { expandHeaderEnvPlaceholders } from "./index.js";

const TRUSTED = "https://routellm.abacus.ai/v1/mcp";
const env = {
  ABACUS_API_KEY: "s3cret",
  ANTHROPIC_API_KEY: "other-secret",
  GITHUB_TOKEN: "gh-secret",
};

describe("expandHeaderEnvPlaceholders", () => {
  it("passes plain headers through untouched", () => {
    expect(
      expandHeaderEnvPlaceholders({ Authorization: "Bearer abc" }, TRUSTED, {})
        .headers
    ).toEqual({ Authorization: "Bearer abc" });
  });

  it("expands the allowlisted variable on the trusted https host", () => {
    const result = expandHeaderEnvPlaceholders(
      { Authorization: "Bearer ${ABACUS_API_KEY}" },
      TRUSTED,
      env
    );

    expect(result.headers).toEqual({ Authorization: "Bearer s3cret" });
    expect(result.credentialExpanded).toBe(true);
  });

  it("never expands a variable that is not allowlisted", () => {
    for (const url of [TRUSTED, "https://attacker.example/mcp"]) {
      expect(
        expandHeaderEnvPlaceholders(
          { "x-a": "${ANTHROPIC_API_KEY}", "x-b": "${GITHUB_TOKEN}" },
          url,
          env
        )
      ).toEqual({ headers: {}, credentialExpanded: false });
    }
  });

  it("does not expand the allowlisted variable for a foreign host", () => {
    expect(
      expandHeaderEnvPlaceholders(
        { Authorization: "Bearer ${ABACUS_API_KEY}" },
        "https://attacker.example/mcp",
        env
      )
    ).toEqual({ headers: {}, credentialExpanded: false });
  });

  it("does not expand over plain http, even on the trusted host", () => {
    expect(
      expandHeaderEnvPlaceholders(
        { Authorization: "Bearer ${ABACUS_API_KEY}" },
        "http://routellm.abacus.ai/v1/mcp",
        env
      )
    ).toEqual({ headers: {}, credentialExpanded: false });
  });

  it("does not expand for a host that merely contains the trusted host", () => {
    for (const url of [
      "https://routellm.abacus.ai.evil.example/mcp",
      "https://evil-routellm.abacus.ai.example.com/mcp",
      "https://notabacus.ai/mcp",
    ]) {
      expect(
        expandHeaderEnvPlaceholders(
          { Authorization: "Bearer ${ABACUS_API_KEY}" },
          url,
          env
        )
      ).toEqual({ headers: {}, credentialExpanded: false });
    }
  });

  it("does not expand for a stdio entry, which has no url at all", () => {
    expect(
      expandHeaderEnvPlaceholders(
        { Authorization: "Bearer ${ABACUS_API_KEY}" },
        undefined,
        env
      )
    ).toEqual({ headers: {}, credentialExpanded: false });
  });

  it("follows the serving host the desktop injects", () => {
    const preprod = {
      ...env,
      ABACUSAI_BOT_ABACUS_V1: "https://x.abacus.ai/v1",
    };

    expect(
      expandHeaderEnvPlaceholders(
        { Authorization: "Bearer ${ABACUS_API_KEY}" },
        "https://x.abacus.ai/v1/mcp",
        preprod
      ).headers
    ).toEqual({ Authorization: "Bearer s3cret" });
    expect(
      expandHeaderEnvPlaceholders(
        { Authorization: "Bearer ${ABACUS_API_KEY}" },
        TRUSTED,
        preprod
      ).headers
    ).toEqual({});
  });

  it("ignores an injected serving host that is not an https abacus.ai one", () => {
    for (const injected of [
      "http://routellm.abacus.ai/v1",
      "https://routellm.abacus.ai.evil.example/v1",
      "not a url",
    ]) {
      expect(
        expandHeaderEnvPlaceholders(
          { Authorization: "Bearer ${ABACUS_API_KEY}" },
          TRUSTED,
          { ...env, ABACUSAI_BOT_ABACUS_V1: injected }
        ).headers
      ).toEqual({});
    }
  });

  it("drops a header whose placeholder has no value, keeping the rest", () => {
    const result = expandHeaderEnvPlaceholders(
      { Authorization: "Bearer ${ABACUS_API_KEY}", "x-static": "kept" },
      TRUSTED,
      { ABACUS_API_KEY: "  " }
    );

    expect(result.headers).toEqual({ "x-static": "kept" });
    expect(result.credentialExpanded).toBe(false);
  });

  it("leaves undefined header maps undefined", () => {
    expect(
      expandHeaderEnvPlaceholders(undefined, TRUSTED, {}).headers
    ).toBeUndefined();
  });

  it("does not treat lowercase or malformed names as placeholders", () => {
    expect(
      expandHeaderEnvPlaceholders({ a: "${not_a_var}", b: "${}" }, TRUSTED, {})
        .headers
    ).toEqual({ a: "${not_a_var}", b: "${}" });
  });
});
