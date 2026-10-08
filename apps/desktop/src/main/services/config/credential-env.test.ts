/**
 * Every key the app can hand its agent must be on the agent's drop list, or a
 * shell the model runs inherits it. GH_TOKEN is the one kept on purpose.
 */
import { CREDENTIAL_ENV_VARS } from "@abacus-ai/agent/secret-paths";
import { PROVIDER_ENV_VARS } from "@abacus-ai/contract/settings";
import { describe, expect, it } from "vitest";

describe("the credentials kept out of the agent's children", () => {
  it("covers every stored provider key but the GitHub token", () => {
    for (const name of Object.values(PROVIDER_ENV_VARS)) {
      if (name === "GH_TOKEN") expect(CREDENTIAL_ENV_VARS).not.toContain(name);
      else expect(CREDENTIAL_ENV_VARS).toContain(name);
    }
  });
});
