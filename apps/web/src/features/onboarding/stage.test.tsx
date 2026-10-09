import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { fixtureBots } from "#renderer/data/fixture-db/rows";
import { defaultLook } from "#renderer/lib/bots/avatar";
vi.mock("#renderer/lib/motion", async (original) => ({
  ...(await original<typeof import("#renderer/lib/motion")>()),
  useMotionPreference: () => "full",
}));
import { OnboardingStage, stageFor, CHOREOGRAPHY } from "./stage";
const bot = {
  ...fixtureBots()[0]!,
  avatarShape: "squircle",
  avatarColor: "#22c55e",
};
it("retains the same four characters while changing the visible cast", () => {
  const ids = stageFor("welcome", null, "none").slots.map((s) => s.id);
  for (const step of Object.keys(CHOREOGRAPHY) as Array<
    keyof typeof CHOREOGRAPHY
  >) {
    expect(stageFor(step, bot, "ready").slots.map((s) => s.id)).toEqual(ids);
  }
});
it("uses the existing product loading avatar as the lead", () => {
  expect(stageFor("welcome", null, "none").slots[0]?.look).toEqual(
    defaultLook("AbacusAI Bot")
  );
});
it("uses the created bot's own look", () => {
  expect(
    stageFor("done", bot, "ready").slots.find((s) => s.id === "first-bot")?.look
      .shape
  ).toBe("squircle");
});
describe("stage", () => {
  it("keeps the actual avatar nodes when connectors and completion rearrange them", () => {
    const view = render(
      <OnboardingStage step="welcome" bot={null} phase="none" reduced={false} />
    );
    const rigs = [
      ...view.container.querySelectorAll('[data-slot="bot-avatar"]'),
    ];
    for (const step of ["connectors", "first-bot", "done"] as const) {
      view.rerender(
        <OnboardingStage step={step} bot={bot} phase="ready" reduced={false} />
      );
      expect([
        ...view.container.querySelectorAll('[data-slot="bot-avatar"]'),
      ]).toEqual(rigs);
    }
  });
  it("removes animated rigs and confetti under reduced motion", () => {
    const view = render(
      <OnboardingStage step="done" bot={bot} phase="ready" reduced={true} />
    );
    expect(view.container.querySelector("[data-animate]")).toBeNull();
    expect(view.container.querySelector('[data-slot="confetti"]')).toBeNull();
  });
});

it("never subscribes to pointer movement and keeps press reactions", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("hover"),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const listener = vi.spyOn(document, "addEventListener");
  const onPoke = vi.fn();
  const view = render(
    <OnboardingStage
      step="welcome"
      bot={null}
      phase="none"
      reduced={false}
      onPoke={onPoke}
    />
  );
  try {
    expect(listener.mock.calls.some(([kind]) => kind === "pointermove")).toBe(
      false
    );
    const avatar = view.container.querySelector(
      '[data-avatar-id="parade-cat"]'
    )!;
    const rig = avatar.querySelector('[data-slot="bot-avatar"]')!;
    const mood = rig.getAttribute("data-mood");
    fireEvent.pointerOver(avatar);
    fireEvent.pointerMove(avatar, {
      clientX: 500,
      clientY: 200,
      pointerType: "mouse",
    });
    expect(rig.getAttribute("data-mood")).toBe(mood);
    fireEvent.pointerDown(rig);
    expect(onPoke).toHaveBeenCalledOnce();
    expect(rig.getAttribute("data-mood")).toBe("excited");
    fireEvent.pointerUp(rig);
  } finally {
    view.unmount();
    listener.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("keeps companions visible while the cloud and Chief anchor completion", () => {
  for (const step of Object.keys(CHOREOGRAPHY) as Array<
    keyof typeof CHOREOGRAPHY
  >) {
    const stage = stageFor(step, bot, "ready");
    expect(stage.slots.filter((slot) => slot.visible)).toHaveLength(
      step === "done" ? 3 : 4
    );
    expect(stage.slots[0]?.main).toBe(true);
    expect(stage.slots[0]?.look).toEqual(defaultLook("AbacusAI Bot"));
  }
  for (const step of ["models", "connectors", "first-bot", "done"] as const) {
    const stage = stageFor(step, bot, "ready");
    expect(stage.slots.filter((slot) => slot.main)).toHaveLength(2);
    if (step === "models" || step === "connectors")
      expect(stage.height).toBe(56);
    else {
      const pair = stage.slots.filter((slot) => slot.main);
      expect(Math.abs((pair[0]!.x + pair[1]!.x) / 2)).toBeLessThan(4);
      expect(pair[0]!.size).toBeGreaterThan(pair[1]!.size);
    }
  }
});

it("turns the existing fourth character into the Chief only when introduced", () => {
  const before = stageFor("models", bot, "ready").slots[3]!;
  const introduced = stageFor("first-bot", bot, "ready").slots[3]!;
  expect(introduced.id).toBe(before.id);
  expect(before.look.shape).toBe("mochi");
  expect(introduced.look.shape).toBe(bot.avatarShape);
  expect(stageFor("first-bot", null, "pending").slots[3]!.look.shape).toBe(
    "egg"
  );
});
