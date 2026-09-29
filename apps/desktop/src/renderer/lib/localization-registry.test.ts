import { CONNECTORS } from "@abacus-ai/connectors/registry";
import { describe, expect, it } from "vitest";

import { PROVIDER_KEY_FIELDS } from "#shared/settings";

import enUS from "../locales/en-US.json";
import { localizeAgentNotice } from "./localize-agent-notice";

describe("localization outside JSX", () => {
  it("covers every registry connector and its setup instructions", () => {
    for (const field of PROVIDER_KEY_FIELDS) {
      expect(enUS.providerHints).toHaveProperty(field.provider);
    }
    for (const connector of CONNECTORS) {
      expect(enUS.connectorDescriptions).toHaveProperty(connector.id);
      for (const [index] of (connector.setup ?? []).entries()) {
        expect(enUS.connectorSetup).toHaveProperty(
          `${connector.id}.step${index}`
        );
      }
    }
  });

  it("preserves unknown provider diagnostics verbatim", () => {
    expect(localizeAgentNotice("HTTP 429: provider-specific detail")).toBe(
      "HTTP 429: provider-specific detail"
    );
  });
});
