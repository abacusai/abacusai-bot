/**
 * The contract between the connect page and the model picker.
 *
 * Three registries describe a provider — PROVIDER_ENV_VARS (where its key is
 * stored), PROVIDER_KEY_FIELDS (the card on the connect page), and
 * MODEL_CATALOG (what the picker offers once the key exists) — and they only
 * work in agreement. A provider present in one and missing in another is a
 * silent dead end: a card that stores a key nothing reads, or a key that
 * connects a provider no model in the picker is gated on. Each drift here is
 * exactly the bug the connect page exists to prevent, so the agreement is
 * pinned as a test rather than trusted to review.
 */
import { describe, expect, it } from "vitest";

import { MODEL_CATALOG } from "./models";
import { PROVIDER_ENV_VARS, PROVIDER_KEY_FIELDS } from "./settings";

const modelFields = PROVIDER_KEY_FIELDS.filter(
  (field) => field.kind === "model"
);

describe("every connect-page card", () => {
  it("names a provider exactly once", () => {
    const providers = PROVIDER_KEY_FIELDS.map((field) => field.provider);

    expect(new Set(providers).size).toBe(providers.length);
  });

  it("stores its key under the env var the save path uses", () => {
    // saveApiKey maps provider → PROVIDER_ENV_VARS[provider] and silently
    // no-ops on an unknown provider, so a card whose entry is missing or
    // disagrees is a field that swallows what the user pastes.
    for (const field of PROVIDER_KEY_FIELDS) {
      expect(
        PROVIDER_ENV_VARS[field.provider],
        `PROVIDER_ENV_VARS is missing or wrong for "${field.provider}"`
      ).toBe(field.envVar);
    }
  });

  it("links somewhere real to get the key", () => {
    for (const field of PROVIDER_KEY_FIELDS) {
      expect(field.signupUrl).toMatch(/^https:\/\//);
      expect(field.hint.length).toBeGreaterThan(0);
    }
  });

  it("points at a key, not at the connect flow", () => {
    // Every card's link answers the same question — where do I get the key —
    // and the two providers with a browser sign-in are no exception: the
    // Connect button next to the link is what performs the sign-in.
    //
    // Abacus's link used to be the sign-in page carrying `AbacusAIBot=1`, the
    // flag that puts that page into connect mode. It then looks for the
    // loopback handshake only startAbacusAuth can mint — the challenge, the
    // port, the callback path — and refuses with "This connect link is invalid
    // or incomplete" without them. Deleting the key and reaching for this link
    // was the shortest route to that dead end.
    for (const field of PROVIDER_KEY_FIELDS) {
      const url = new URL(field.signupUrl);

      expect(
        url.searchParams.has("AbacusAIBot"),
        `${field.provider}'s key link claims to be a connect callback`
      ).toBe(false);
      expect(
        url.pathname,
        `${field.provider}'s key link is the app's own sign-in page`
      ).not.toContain("/chatllm/signin");
    }
  });
});

describe("every model-kind provider", () => {
  it("has at least one picker entry gated on its key", () => {
    // A key that connects a provider with no catalog entry is invisible: the
    // card flips to Configured and the picker never changes.
    for (const field of modelFields) {
      const entries = MODEL_CATALOG.filter(
        (model) => model.provider === field.provider
      );

      expect(
        entries.length,
        `no MODEL_CATALOG entry for "${field.provider}"`
      ).toBeGreaterThan(0);

      for (const entry of entries) {
        expect(
          entry.requiresEnv,
          `${entry.id} is gated on the wrong env var`
        ).toBe(field.envVar);
      }
    }
  });
});

describe("the catalog itself", () => {
  it("has no duplicate ids", () => {
    const ids = MODEL_CATALOG.map((model) => model.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gates every keyed entry on a variable the settings file can hold", () => {
    // openllm/auto and openai-codex authenticate another way; everything else
    // with a requiresEnv must use a name the save path can actually write.
    const known = new Set(Object.values(PROVIDER_ENV_VARS));

    for (const model of MODEL_CATALOG) {
      if (model.requiresEnv == null) continue;

      expect(
        known.has(model.requiresEnv),
        `${model.id} requires ${model.requiresEnv}, which no card stores`
      ).toBe(true);
    }
  });
});
