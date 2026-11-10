import { describe, expect, it } from "vitest";

// mq-sandbox test D: fails on Windows only, so a pull request run (Linux)
// passes and the merge queue run (all systems) has to stop it.
describe("mq-sandbox", () => {
  it("is not running on Windows", () => {
    expect(process.platform).not.toBe("win32");
  });
});
