import { describe, expect, it } from "vitest";

import { handedOffSessionId } from "./handoff";

describe("handedOffSessionId", () => {
  it("reads the new chat's id from hand_off_session's result, as main writes it", () => {
    expect(
      handedOffSessionId(
        "Started a new chat (session: 5f0c1d2e-aa11-4b2c-9d3e-0123456789ab) on “Fix session: x”. It runs on its own."
      )
    ).toBe("5f0c1d2e-aa11-4b2c-9d3e-0123456789ab");
    expect(handedOffSessionId("This chat cannot hand work off.")).toBeNull();
  });
});
