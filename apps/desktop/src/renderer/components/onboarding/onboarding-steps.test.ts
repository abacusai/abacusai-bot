/**
 * The shape of a first run.
 *
 * Five screens, in one order, for everybody: the sign-in, the account's
 * welcome, the connectors, the models, and the guided tour. The only thing
 * that varies is whether the sign-in is needed, because someone can arrive
 * already holding a credential.
 *
 * Asserted here rather than through the UI because the ordering *is* the
 * requirement — every bug this file has caught was a screen in the wrong place
 * or a step quietly dropped, and a dropped step turned "skip this page" into
 * "leave onboarding".
 */
import { describe, expect, it } from "vitest";

import {
  nextStep,
  previousStep,
  stepProgress,
  stepsFor,
} from "./onboarding-steps";

describe("a profile that has done this before", () => {
  it("gets the sign-in wall and nothing behind it", () => {
    // Signing out keeps `onboarded`, so without this the second sign-in of an
    // account's life replayed the welcome, connectors, models and the tour.
    expect(
      stepsFor({ signedIn: false, paying: false, onboarded: true })
    ).toEqual(["auth"]);
  });

  it("has no screens at all once the credential is back", () => {
    expect(
      stepsFor({ signedIn: true, paying: false, onboarded: true })
    ).toEqual([]);
  });

  it("leaves a genuine first run alone", () => {
    expect(
      stepsFor({ signedIn: false, paying: false, onboarded: false })
    ).toEqual(["auth", "welcome", "connectors", "models", "explainer"]);
  });
});

describe("the shape of a first run", () => {
  it("walks a new user through everything", () => {
    expect(stepsFor({ signedIn: false, paying: false })).toEqual([
      "auth",
      "welcome",
      "connectors",
      "models",
      "explainer",
    ]);
  });

  it("does not ask a signed-in user to sign in again", () => {
    expect(stepsFor({ signedIn: true, paying: false })).toEqual([
      "welcome",
      "connectors",
      "models",
      "explainer",
    ]);
  });

  it("welcomes the account the moment it exists", () => {
    const steps = stepsFor({
      signedIn: false,
      paying: false,
    });

    expect(steps[steps.indexOf("auth") + 1]).toBe("welcome");
  });

  it("shows the models step to everybody, subscriber or not", () => {
    // Dropping it for a paid account made "skip" on the screen before it fall
    // out of onboarding altogether.
    expect(stepsFor({ signedIn: true, paying: false })).toContain("models");
  });

  it("spares a paying tier the models screen, and nothing else", () => {
    const paying = stepsFor({
      signedIn: true,
      paying: true,
    });

    expect(paying).toEqual(["welcome", "connectors", "explainer"]);
    // The tour is not skipped: paying users still get the lap.
    expect(paying).toContain("explainer");
  });

  it("keeps the tour in the route whether or not a folder is open yet", () => {
    // Every stop spotlights a piece of the workspace, and the tour used to be
    // dropped when there was none. Dropping it meant it was never seen at all:
    // the flow is the only thing that opens it, and nothing re-armed it once a
    // folder appeared later. The flow now makes the default workspace on the
    // way into the step, so the route always carries it.
    for (const signedIn of [true, false]) {
      const steps = stepsFor({ signedIn, paying: false });

      expect(steps).toContain("explainer");
    }
  });

  it("ends on the tour, after the screens that make a window worth seeing", () => {
    for (const signedIn of [true, false]) {
      const steps = stepsFor({ signedIn, paying: false });
      expect(steps[steps.length - 1]).toBe("explainer");
      expect(steps.filter((step) => step === "explainer")).toHaveLength(1);
    }
  });
});

describe("moving through it", () => {
  const steps = stepsFor({
    signedIn: false,
    paying: false,
  });

  it("goes forwards and backwards", () => {
    expect(nextStep(steps, "connectors")).toBe("models");
    expect(previousStep(steps, "models")).toBe("connectors");
  });

  it("reports the end of the flow rather than a step", () => {
    expect(nextStep(steps, "explainer")).toBe(null);
    expect(previousStep(steps, "auth")).toBe(null);
  });

  it("counts the dots against the route actually being walked", () => {
    expect(stepProgress(steps, "connectors")).toEqual({ index: 2, total: 5 });
    expect(
      stepProgress(stepsFor({ signedIn: true, paying: false }), "connectors")
    ).toEqual({
      index: 1,
      total: 4,
    });
  });
});
