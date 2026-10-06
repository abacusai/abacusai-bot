/**
 * The stage: the avatars are shared elements. `stageFor` names them per
 * step with stable ids (canvas OnboardWelcome → OnboardDone), and the
 * rendered element for an id survives a step change (so Motion can morph
 * it rather than mount a new one). The egg becomes the created bot's own
 * look, and that bot carries the shell's identity name on `done`.
 */
import type { BotRow } from "@abacus-ai/contract/contract";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { fixtureBots } from "#renderer/data/fixture-db/rows";

// The hatch reads the motion preference from prefs; the stage is given it.
vi.mock("#renderer/lib/motion", async (original) => ({
  ...(await original<typeof import("#renderer/lib/motion")>()),
  useMotionPreference: () => "full",
}));

import { OnboardingStage, PARADE, stageFor } from "./stage";

const bot = {
  ...fixtureBots()[0]!,
  avatarShape: "squircle",
  avatarColor: "#22c55e",
};
const ids = (
  step: Parameters<typeof stageFor>[0],
  b: BotRow | null = bot,
  phase: Parameters<typeof stageFor>[2] = "ready"
) => stageFor(step, b, phase).slots.map((slot) => slot.id);

describe("stageFor", () => {
  it("shows the five-bot parade on welcome, in the canvas's sizes", () => {
    const { slots, height } = stageFor("welcome", null, "none");
    expect(height).toBe(120);
    expect(slots.map((s) => [s.id, s.size, s.mood, s.look.accessory])).toEqual([
      ["parade-bunny", 56, "happy", "bow"],
      ["parade-blob", 72, "wink", "none"],
      ["parade-mochi", 88, "idle", "glasses"],
      ["parade-cat", 72, "love", "none"],
      ["parade-star", 56, "excited", "crown"],
    ]);
  });

  it("keeps the green blob as the one that waits and then gets the check", () => {
    expect(ids("connect")).toEqual(["parade-blob"]);
    expect(stageFor("connect", null, "none").slots[0]).toMatchObject({
      mood: "waiting",
      size: 88,
      look: PARADE["parade-blob"].look,
    });
    expect(stageFor("connected", null, "none").slots[0]).toMatchObject({
      id: "parade-blob",
      mood: "happy",
      size: 96,
      badge: true,
    });
  });

  it("has no avatar on models and connectors", () => {
    expect(ids("models")).toEqual([]);
    expect(ids("connectors")).toEqual([]);
    expect(stageFor("models", bot, "ready").height).toBe(0);
  });

  it("hatches the egg into the created bot's own look, under the pulse glow", () => {
    const pending = stageFor("first-bot", null, "pending").slots[0]!;
    expect(pending).toMatchObject({
      id: "first-bot",
      size: 112,
      glow: true,
      look: { shape: "egg", color: "#4ade80" },
    });
    expect(pending.hatch).toBeUndefined();
    const ready = stageFor("first-bot", bot, "ready").slots[0]!;
    expect(ready).toMatchObject({
      id: "first-bot",
      hatch: true,
      glow: true,
      look: { shape: "squircle", color: "#4ade80" },
    });
    expect(ids("first-bot", null, "none")).toEqual([]);
  });

  it("keeps the first bot in the centre on done, carrying the shell's identity name", () => {
    const { slots } = stageFor("done", bot, "ready");
    expect(slots.map((s) => [s.id, s.size])).toEqual([
      ["parade-bunny", 56],
      ["first-bot", 80],
      ["parade-cat", 56],
    ]);
    expect(slots[1]).toMatchObject({
      mood: "excited",
      shared: `bot-identity-${bot.id}`,
      look: { shape: "squircle" },
    });
    expect(ids("done", null, "none")).toEqual([
      "parade-bunny",
      "parade-blob",
      "parade-cat",
    ]);
  });
});

describe("OnboardingStage", () => {
  const avatar = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLElement>(`[data-avatar-id="${id}"]`);

  it("keeps the same element mounted across steps and resizes it in place", () => {
    const { container, rerender } = render(
      <OnboardingStage step="welcome" bot={null} phase="none" reduced={false} />
    );
    const blob = avatar(container, "parade-blob")!;
    expect(blob.getAttribute("data-size")).toBe("72");
    expect(container.querySelectorAll("[data-avatar-id]")).toHaveLength(5);
    rerender(
      <OnboardingStage step="connect" bot={null} phase="none" reduced={false} />
    );
    expect(avatar(container, "parade-blob")).toBe(blob);
    expect(blob.getAttribute("data-size")).toBe("88");
    expect(
      blob.querySelector('[data-slot="bot-avatar"]')!.getAttribute("data-mood")
    ).toBe("waiting");
    rerender(
      <OnboardingStage
        step="connected"
        bot={null}
        phase="none"
        reduced={false}
      />
    );
    expect(avatar(container, "parade-blob")).toBe(blob);
    expect(blob.querySelector(".onboarding-badge")).not.toBeNull();
  });

  it("carries the hatched bot from first-bot to done as one element", () => {
    const { container, rerender } = render(
      <OnboardingStage
        step="first-bot"
        bot={null}
        phase="pending"
        reduced={false}
      />
    );
    const first = avatar(container, "first-bot")!;
    expect(first.querySelector(".onboarding-glow")).not.toBeNull();
    expect(
      first
        .querySelector('[data-slot="bot-avatar"]')!
        .getAttribute("data-shape")
    ).toBe("egg");
    rerender(
      <OnboardingStage
        step="first-bot"
        bot={bot}
        phase="ready"
        reduced={false}
      />
    );
    expect(avatar(container, "first-bot")).toBe(first);
    rerender(
      <OnboardingStage step="done" bot={bot} phase="ready" reduced={false} />
    );
    expect(avatar(container, "first-bot")).toBe(first);
    expect(first.getAttribute("data-size")).toBe("80");
    expect(first.style.viewTransitionName).toBe(`bot-identity-${bot.id}`);
    expect(
      first
        .querySelector('[data-slot="bot-avatar"]')!
        .getAttribute("data-shape")
    ).toBe("squircle");
  });

  it("staggers the idle bob and stops the mood keyframes under reduced motion", () => {
    const { container, rerender } = render(
      <OnboardingStage step="welcome" bot={null} phase="none" reduced={false} />
    );
    const bobs = [
      ...container.querySelectorAll<HTMLElement>(".onboarding-bob"),
    ];
    expect(bobs.map((b) => b.style.animationDelay)).toEqual([
      "0s",
      "0.4s",
      "0.8s",
      "1.2s",
      "1.6s",
    ]);
    expect(
      container
        .querySelector('[data-slot="bot-avatar"]')!
        .hasAttribute("data-animate")
    ).toBe(true);
    rerender(
      <OnboardingStage step="welcome" bot={null} phase="none" reduced={true} />
    );
    expect(
      container
        .querySelector('[data-slot="bot-avatar"]')!
        .hasAttribute("data-animate")
    ).toBe(false);
  });

  it("hides the stage when a step has no avatar", () => {
    const { container } = render(
      <OnboardingStage step="models" bot={bot} phase="ready" reduced={false} />
    );
    expect(
      container.querySelector(".onboarding-stage")!.hasAttribute("data-empty")
    ).toBe(true);
  });
});
