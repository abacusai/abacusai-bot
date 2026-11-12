import { BOT_TEMPLATES } from "@abacus-ai/contract/bots/templates";
import { describe, expect, it } from "vitest";

import {
  BUILD_PROJECTS,
  PROJECT_SLOTS,
  PROJECT_STARTERS,
  PROJECT_TABS,
  projectsIn,
} from "./build-starters";
import { PROJECT_ICONS } from "./project-icons";

describe("project starters", () => {
  it("names a real template for every bot project and an icon for every project", () => {
    for (const project of PROJECT_STARTERS) {
      expect(PROJECT_ICONS[project.id]).toBeDefined();
      if (project.kind === "bot")
        expect(
          BOT_TEMPLATES.some((template) => template.id === project.templateId)
        ).toBe(true);
    }
    expect(new Set(PROJECT_STARTERS.map((p) => p.id)).size).toBe(
      PROJECT_STARTERS.length
    );
  });

  it.each(PROJECT_TABS)("gives the %s tab projects of its own", (tab) => {
    const shown = projectsIn(tab);
    expect(shown.length).toBeGreaterThanOrEqual(2);
    if (tab !== "popular")
      expect(shown.every((p) => p.categories.includes(tab))).toBe(true);
  });

  it("shows the catalog's head under Popular, without the hidden ones", () => {
    expect(projectsIn("popular")).toEqual(
      PROJECT_STARTERS.slice(0, PROJECT_SLOTS)
    );
    const shown = projectsIn("popular", ["morning-inbox"]);
    expect(shown.map((p) => p.id)).not.toContain("morning-inbox");
    expect(shown).toHaveLength(PROJECT_SLOTS);
  });

  it("offers only build projects on the start page", () => {
    expect(BUILD_PROJECTS.every((p) => p.kind === "build")).toBe(true);
  });
});
