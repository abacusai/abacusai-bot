import { describe, expect, it } from "vitest";

import {
  guardStep,
  next,
  ONBOARDING_FLOW,
  resumeStep,
  type FlowFacts,
} from "./machine";
const facts: FlowFacts[] = [false, true].flatMap((signedIn) =>
  [false, true].flatMap((payingTier) =>
    [false, true].map((ownsBot) => ({ signedIn, payingTier, ownsBot }))
  )
);
describe("R6-T4 step machine and R6-T5 resume", () => {
  it.each(facts)("covers transition branches with %j", (f) => {
    expect(next("welcome", { type: "skip" }, f, null)).toBe("ignore");
    expect(next("welcome", { type: "sign-in", attempt: "a" }, f, "a")).toBe(
      "connect"
    );
    expect(next("connect", { type: "auth-ok", attempt: "a" }, f, "a")).toBe(
      "connected"
    );
    expect(next("connect", { type: "auth-failed", attempt: "a" }, f, "a")).toBe(
      "connect"
    );
    expect(next("connect", { type: "auth-ok", attempt: "old" }, f, "a")).toBe(
      "ignore"
    );
    expect(next("connected", { type: "next" }, f, null)).toBe(
      f.payingTier ? "connectors" : "models"
    );
    expect(next("models", { type: "back" }, f, null)).toBe(
      f.signedIn ? "connected" : "welcome"
    );
    expect(next("models", { type: "next" }, f, null)).toBe("connectors");
    expect(next("connectors", { type: "next" }, f, null)).toBe(
      f.ownsBot ? "done" : "first-bot"
    );
    expect(next("connectors", { type: "back" }, f, null)).toBe(
      f.payingTier ? "connected" : "models"
    );
    expect(next("first-bot", { type: "tour" }, f, null)).toBe("complete");
    expect(next("done", { type: "next" }, f, null)).toBe("complete");
  });
  it("keeps failed attempts and own optimistic bot creation valid", () => {
    const f = { signedIn: true, payingTier: false, ownsBot: true };
    expect(
      guardStep("connect", f, {
        signIn: { status: "failed" },
        createdBotId: null,
      })
    ).toBe("connect");
    expect(guardStep("connect", f, { signIn: null, createdBotId: null })).toBe(
      "welcome"
    );
    expect(
      guardStep("first-bot", f, { signIn: null, createdBotId: "client" })
    ).toBe("first-bot");
    expect(
      guardStep("first-bot", f, { signIn: null, createdBotId: null })
    ).toBe("done");
  });
  it.each(ONBOARDING_FLOW)("resumes canonical %s only in flow 2", (step) => {
    expect(resumeStep({ step, flow: 2 })).toBe(
      step === "connect" ? "welcome" : step
    );
    expect(resumeStep({ step, flow: null })).toBe("welcome");
  });
});
