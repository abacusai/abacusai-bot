/**
 * What the agent is told about the account at spawn: its credits, which
 * drive the router's starter phase, and nothing when the deployment does
 * not report them.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./settings", () => ({
  credentialEnv: () => ({}),
  hasCredential: () => false,
  readDockerImage: () => null,
  readExecBackend: () => null,
  readToolsetPreferences: () => ({}),
}));

const { buildAgentCreditsEnv } = await import("./agent-env");

describe("the credits handed to the agent", () => {
  it("carries both figures when the account reports them", () => {
    expect(
      buildAgentCreditsEnv({ credits_used: 496.5, credits_granted: 2000 })
    ).toEqual({
      ABACUSAI_BOT_CREDITS_USED: "496.5",
      ABACUSAI_BOT_CREDITS_GRANTED: "2000",
    });
  });

  it("says nothing when either figure is missing, or the account is unknown", () => {
    expect(
      buildAgentCreditsEnv({ credits_used: 10, credits_granted: null })
    ).toEqual({});
    expect(buildAgentCreditsEnv(null)).toEqual({});
  });
});
