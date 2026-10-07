/**
 * A message the user steers into a running turn reaches the profile's
 * `noteUserWords` like a turn's own text does: a consent can be given mid-task.
 */
import { describe, expect, it, vi } from "vitest";

import { ForeverEngine } from "./engine.js";

describe("the user's words, mid-turn", () => {
  it("are noted for a steered message, and not for one steered into housekeeping", async () => {
    const noteUserWords = vi.fn();
    const deliver = vi.fn(async () => undefined);
    const engine = {
      upkeep: false,
      hiddenTurn: false,
      profile: { noteUserWords },
      midTask: { live: true, deliver },
    };
    const steer = ForeverEngine.prototype.steer;
    await steer.call(engine as never, "yes, keep the passport too", "m2");
    expect(noteUserWords).toHaveBeenCalledWith("yes, keep the passport too");

    noteUserWords.mockClear();
    await steer.call({ ...engine, hiddenTurn: true } as never, "yes", "m3");
    expect(noteUserWords).not.toHaveBeenCalled();
  });
});
