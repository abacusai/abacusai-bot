import { describe, expect, it } from "vitest";

import { selectSkills } from "./skills-tools";

describe("R5-T21 disk skill baseline", () => {
  const disk = [{ id: "disk" }];
  it("keeps disk commands before hydration and after empty live updates", () => {
    expect(selectSkills(undefined, disk)).toBe(disk);
    expect(selectSkills([], disk)).toBe(disk);
  });
  it("prefers nonempty live commands", () => {
    const live = [{ id: "live" }];
    expect(selectSkills(live, disk)).toBe(live);
  });
});
