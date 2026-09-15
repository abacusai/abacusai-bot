/**
 * The shape of a first run, and how the flow settles when the facts behind
 * the route change. The ordering is the requirement, so it is pinned here.
 */
import { describe, expect, it } from "vitest";

import {
  nextStep,
  previousStep,
  settleStep,
  stepProgress,
  stepsFor,
} from "./onboarding-steps";

describe("a profile that has done this before", () => {
  it("gets the sign-in wall and nothing behind it", () => {
    // Signing out keeps `onboarded`; a returning account is owed no replay.
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

  it("shows the models step to a free account", () => {
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

  it("has nowhere to go from a screen the route does not hold", () => {
    expect(nextStep(stepsFor({ signedIn: true, paying: true }), "models")).toBe(
      null
    );
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

describe("settling the screen when the route changes under it", () => {
  const signedOut = stepsFor({ signedIn: false, paying: false });
  const signedIn = stepsFor({ signedIn: true, paying: false });

  it("keeps a screen the route still has", () => {
    expect(settleStep(signedIn, "connectors")).toBe("connectors");
    expect(settleStep(signedOut, "auth")).toBe("auth");
  });

  it("moves off the wall once a credential arrives", () => {
    expect(settleStep(signedIn, "auth")).toBe("welcome");
  });

  it("returns to the wall when the credential goes, from any screen", () => {
    for (const step of [
      "welcome",
      "connectors",
      "models",
      "explainer",
    ] as const)
      expect(settleStep(signedOut, step)).toBe("auth");
  });

  it("skips ahead when the route dropped the current screen", () => {
    // The tier arrived while the models screen was showing.
    expect(
      settleStep(stepsFor({ signedIn: true, paying: true }), "models")
    ).toBe("explainer");
  });

  it("reports nothing left for a returning account that signed back in", () => {
    expect(
      settleStep(
        stepsFor({ signedIn: true, paying: false, onboarded: true }),
        "auth"
      )
    ).toBe(null);
  });
});
