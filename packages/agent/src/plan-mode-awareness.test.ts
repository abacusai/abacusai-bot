/**
 * Plan mode refuses every shell command, and used to say so only by refusing.
 * A repo-comprehension run spent 12 of 66 tool calls finding that out. These
 * pin the sentence that replaces those twelve, and the two properties that
 * keep it honest: it names the tools that still work, and it never claims to
 * know which mode the session is in.
 */
import { describe, expect, it } from "vitest";

import { planModePrompt } from "./session.js";

const roster = (...names: string[]) => new Set(names);

describe("what the model is told about plan mode", () => {
  it("says the shell is refused even for read-only commands", () => {
    const prompt = planModePrompt(roster("bash", "read", "grep"));

    expect(prompt).toContain("refuses every shell command");
    // The three from the measured run, so the model recognises its own case.
    expect(prompt).toContain("ls");
    expect(prompt).toContain("git log");
    expect(prompt).toContain("grep");
  });

  it("names run_tests too, which is refused for the same reason", () => {
    expect(planModePrompt(roster("bash"))).toContain("run_tests");
  });

  it("points at the tools that stay available, and at the way out", () => {
    const prompt = planModePrompt(roster("bash")) ?? "";

    for (const tool of ["read", "grep", "ls", "exit_plan_mode"]) {
      expect(prompt).toContain(tool);
    }
  });

  /**
   * The system prompt is the cached prefix of every request and cannot vary
   * turn to turn, but the mode changes whenever the user says so. Stating the
   * rule rather than the current mode is what makes it safe to include always.
   */
  it("states the rule without claiming the session is in that mode", () => {
    const prompt = planModePrompt(roster("bash")) ?? "";

    expect(prompt).not.toMatch(/you are (currently )?in plan mode/i);
    expect(prompt).not.toMatch(/this session is in/i);
  });

  it("says nothing when there is no shell to be refused", () => {
    expect(planModePrompt(roster("read", "grep"))).toBeNull();
  });
});
