import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { fixtureBots } from "#renderer/data/fixture-db/rows";
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
it("keeps a four-character cast through every step", () => {
  const ids = stageFor("welcome", null, "none").slots.map((s) => s.id);
  for (const step of Object.keys(CHOREOGRAPHY) as Array<
    keyof typeof CHOREOGRAPHY
  >) {
    expect(stageFor(step, bot, "ready").slots.map((s) => s.id)).toEqual(ids);
  }
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
