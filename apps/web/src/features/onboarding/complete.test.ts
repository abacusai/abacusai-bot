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
    let failure = failAt;
    const call = async (name: string) => {
      calls.push(name);
      if (name === failure) throw new Error("offline");
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
    return {
      deps,
      calls,
      recover: () => {
        failure = "";
      },
    };
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
  it("creates the sponsored first bot before marking onboarding complete, once across concurrent completion", async () => {
    const { deps, calls } = setup();
    deps.resolveExit = async () => {
      expect(calls).toEqual([]);
      calls.push("first-bot");
      return { to: "bot", botId: "chief" };
    };
    await Promise.all([
      completeOnboarding(deps, { to: "new-bot" }),
      completeOnboarding(deps, { to: "new-bot" }),
    ]);
    expect(calls.filter((call) => call === "first-bot")).toHaveLength(1);
    expect(calls.indexOf("first-bot")).toBeLessThan(calls.indexOf("commit"));
  });
  it("keeps setup unfinished after creation fails and allows a single successful retry", async () => {
    const { deps, calls } = setup();
    const resolve = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ to: "bot", botId: "chief" });
    deps.resolveExit = resolve;
    await expect(
      completeOnboarding(deps, { to: "bot", botId: "preview" })
    ).rejects.toThrow("offline");
    expect(calls).toEqual([]);
    await Promise.all([
      completeOnboarding(deps, { to: "bot", botId: "preview" }),
      completeOnboarding(deps, { to: "bot", botId: "preview" }),
    ]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(calls.filter((call) => call === "account")).toHaveLength(1);
    expect(calls.filter((call) => call === "commit")).toHaveLength(1);
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
    const { deps, calls, recover } = setup("step");
    await completeOnboarding(deps, { to: "new-session" });
    expect(calls).toEqual(["exit", "account", "funnel", "step", "commit"]);
    recover();
    await finishCompletion(deps, { to: "new-session" });
    expect(calls.slice(-4)).toEqual(["funnel", "step", "commit", "clear"]);
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
