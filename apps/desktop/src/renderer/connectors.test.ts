import { describe, expect, it } from "vitest";

import { CONNECTORS } from "./connectors";
import enUS from "./locales/en-US.json";

describe("connector descriptions", () => {
  it("has an en-US string for every connector, matching the registry", () => {
    const strings = enUS.connectors.descriptions as Record<string, string>;
    for (const connector of CONNECTORS)
      expect(strings[connector.id], connector.id).toBe(connector.description);
  });
});
