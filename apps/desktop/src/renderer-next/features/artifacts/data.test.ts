import { describe, it, expect } from "vitest";

import type {
  ArtifactRow,
  SessionRow,
  RoutineRow,
  BotRow,
} from "#shared/contract/rows";

import { cardWindow, filterArtifacts, sourceFor, artifactTarget } from "./data";
const artifact = {
  id: "a",
  sessionId: "s",
  workspaceId: "w",
  kind: "file",
  title: "résumé",
  location: "/a.txt",
  updatedAt: "2026-01-01",
} as ArtifactRow;
const session = {
  id: "s",
  workspaceId: "w",
  label: "Daily dispatch",
  routineId: "r",
  owner: null,
} as SessionRow;
const routine = { id: "r", name: "Briefing", botId: "b" } as RoutineRow;
describe("artifact provenance and bounded cards", () => {
  it("R5-T14 separates routine display from bot provenance and searches session labels", () => {
    const source = sourceFor(
      artifact,
      [session],
      [routine],
      [{ id: "b", name: "Ada" } as BotRow],
      []
    );
    expect(source.label).toBe("Briefing");
    expect(source.botIds).toEqual(["b"]);
    const sources = new Map([["a", source]]);
    expect(
      filterArtifacts([artifact], sources, {
        from: "bot:b",
        q: "daily dispatch",
      })
    ).toEqual([artifact]);
    expect(filterArtifacts([artifact], sources, { q: "resume" })).toEqual([
      artifact,
    ]);
    expect(filterArtifacts([artifact], sources, { from: "routines" })).toEqual([
      artifact,
    ]);
    expect(filterArtifacts([artifact], sources, { from: "bot:other" })).toEqual(
      []
    );
  });
  it("R5-T14 routes routine artifacts to the report", () => {
    expect(
      artifactTarget(sourceFor(artifact, [session], [routine], [], []), "s")
    ).toEqual({
      to: "/routines/$routineId",
      params: { routineId: "r" },
      search: { run: "s" },
    });
    expect(artifactTarget(sourceFor(artifact, [], [], [], []), "s")).toBeNull();
  });
  it.each([0, 1000, 10000, 100000])(
    "R5-T31 window arithmetic mounts at most 400 cards at scroll %i",
    (scroll) => {
      const range = cardWindow(2000, scroll, 4, 180);
      expect(range.end - range.start).toBeLessThanOrEqual(400);
      expect(range.start).toBeGreaterThanOrEqual(0);
      expect(range.end).toBeLessThanOrEqual(2000);
    }
  );
});
