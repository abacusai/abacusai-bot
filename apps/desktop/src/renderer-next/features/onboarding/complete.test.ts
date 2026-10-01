import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  completeOnboarding,
  finishCompletion,
  type CompletionDeps,
} from "./actions";
describe("R6-T6 completion persistence boundaries", () => {
  const setup = (failAt = "") => {
    const calls: string[] = [];
    const call = async (name: string) => {
      calls.push(name);
      if (name === failAt) throw new Error("offline");
    };
    const deps = {
      db: {
        updatePrefs: (patch: object) =>
          call(
            Object.keys(patch)[0] === "onboardingExit"
              ? Object.values(patch)[0] === null
                ? "clear"
                : "exit"
              : "step"
          ),
      },
      transport: {
        orpc: {
          account: {
            state: { queryOptions: () => ({ queryKey: ["account"] }) },
          },
        },
        client: {
          account: {
            skipOnboarding: async () => {
              await call("account");
              return { onboarded: true };
            },
          },
          system: { funnelStep: vi.fn(async () => call("funnel")) },
        },
      },
      queryClient: new QueryClient(),
      navigate: () => call("commit"),
      startTour: () => {
        calls.push("tour");
      },
    } as unknown as CompletionDeps;
    return { deps, calls };
  };
  it("persists exit first and clears only after commit and tour activation", async () => {
    const { deps, calls } = setup();
    await completeOnboarding(deps, { to: "bot-tour", botId: "b" });
    expect(calls).toEqual([
      "exit",
      "account",
      "funnel",
      "step",
      "commit",
      "tour",
      "clear",
    ]);
    expect(deps.transport.client.system.funnelStep).toHaveBeenCalledWith({
      step: "onboarding_done",
      once: true,
    });
  });
  it("shares the completion tail with a concurrent shell resume", async () => {
    const { deps, calls } = setup();
    await Promise.all([
      finishCompletion(deps, { to: "bot-tour", botId: "b" }),
      finishCompletion(deps, { to: "bot-tour", botId: "b" }),
    ]);
    expect(calls).toEqual(["funnel", "step", "commit", "tour", "clear"]);
  });
  it("commits the destination but retains the target if step cleanup fails", async () => {
    const { deps, calls } = setup("step");
    await completeOnboarding(deps, { to: "new-session" });
    expect(calls).toEqual(["exit", "account", "funnel", "step", "commit"]);
  });
  it.each(["exit", "account", "funnel", "commit"])(
    "retains recoverable target when %s fails",
    async (failure) => {
      const { deps, calls } = setup(failure);
      await expect(
        completeOnboarding(deps, { to: "new-session" })
      ).rejects.toThrow();
      expect(calls).not.toContain("clear");
      if (failure === "exit" || failure === "account")
        expect(calls).not.toContain("funnel");
      const resumed = setup();
      await finishCompletion(resumed.deps, { to: "new-session" });
      expect(resumed.calls).toEqual(["funnel", "step", "commit", "clear"]);
    }
  );
});
