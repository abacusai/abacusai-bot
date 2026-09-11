import { describe, expect, it } from "vitest";

import baseLocale from "../../locales/en-US.json";
import { SESSION_STARTERS } from "./session-starters";

const strings = (
  baseLocale as {
    workspace: {
      welcome: {
        starters: Record<string, { name: string; description: string }>;
      };
    };
  }
).workspace.welcome.starters;

describe("session starters", () => {
  /**
   * A card with no copy renders its own key as its title. The i18n guard only
   * checks that used keys resolve, and these are built from an id at runtime,
   * so nothing else would catch a starter added without its two strings.
   */
  it("has a name and a description for every starter", () => {
    for (const starter of SESSION_STARTERS) {
      expect(strings[starter.id]?.name).toBeTruthy();
      expect(strings[starter.id]?.description).toBeTruthy();
    }
  });

  it("carries no copy for a starter that no longer exists", () => {
    const ids = new Set(SESSION_STARTERS.map((starter) => starter.id));

    expect(Object.keys(strings).filter((id) => !ids.has(id))).toEqual([]);
  });

  /** Two rows of three at full width; a seventh card leaves a stray row. */
  it("stays at six", () => {
    expect(SESSION_STARTERS).toHaveLength(6);
  });

  it("keeps ids unique, since they key both the copy and the icon", () => {
    const ids = SESSION_STARTERS.map((starter) => starter.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The defect that made these useless: a card that opens with "for the
   * thing I describe next" promises work and hands back a form. Every
   * starter has to name a job it can begin on as it stands.
   */
  it("names a job rather than asking what the job is", () => {
    for (const starter of SESSION_STARTERS) {
      expect(starter.prompt).not.toMatch(
        /I(?:'m| am)? ?(?:about to|going to)|describe next|I describe|point you at/i
      );
    }
  });

  /**
   * Long enough to carry a limit and a request for a report — the two things
   * people leave out — and short enough to read in a composer before editing.
   * The upper bound is the one that keeps drifting: prose creeps back in as
   * "not one screen at its best moment" and the prompt turns into a pitch.
   */
  /**
   * An em dash is the tell of text written to be admired rather than read,
   * and these are read in a composer by someone about to edit them. Same for
   * the clause that justifies a choice already made ("SQLite, so it survives
   * a restart"), which no rule can catch, so it is named here for the next
   * person adding a card.
   */
  it("uses no em dashes, in the prompt or on the card", () => {
    for (const starter of SESSION_STARTERS) {
      expect(starter.prompt).not.toContain("—");
      expect(strings[starter.id]?.name).not.toContain("—");
      expect(strings[starter.id]?.description).not.toContain("—");
    }
  });

  /**
   * Short enough to read in a composer before editing it. The upper bound is
   * the one that keeps drifting: prose creeps back in as "not one screen at
   * its best moment" and the prompt turns into a pitch.
   *
   * There is deliberately no rule that every prompt asks for a report. The
   * ones whose answer IS the deliverable do; the app builder does not, since
   * an app that runs needs no covering note.
   */
  it("stays short enough to read before editing", () => {
    for (const starter of SESSION_STARTERS) {
      const words = starter.prompt.split(/\s+/).length;
      expect(words).toBeGreaterThan(25);
      expect(words).toBeLessThan(100);
    }
  });
});
