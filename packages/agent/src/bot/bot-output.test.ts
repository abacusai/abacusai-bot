import { describe, expect, it } from "vitest";

import { tidyBotText } from "./bot-output.js";

describe("tidying whole messages", () => {
  it("drops a leaked role prefix and collapses blank-line runs", () => {
    expect(tidyBotText("Assistant: Hello.\n\n\n\nBye.")).toBe("Hello.\n\nBye.");
  });
});
