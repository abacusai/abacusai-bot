import type { NotchLayout } from "@abacus-ai/contract/contract/notch";
import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { NotchBody, NotchHeader, NotchSurface } from "./frame";
import { shellClip } from "./shell-clip";

const springs = vi.hoisted(() => [] as (() => void)[]);
vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()),
  animate: () => {
    const finished = new Promise<void>((resolve) => springs.push(resolve));
    return Object.assign(finished, { stop() {} });
  },
}));

it("hides destination content throughout a shell resize, then reveals it", async () => {
  const layout: NotchLayout = {
    displayId: 3,
    mode: "capsule",
    notch: null,
    growth: "down",
    maxShape: { width: 560, height: 220 },
  };
  const shell = (shape: { width: number; height: number }) => (
    <NotchSurface layout={layout} shape={shape} reduced={false} expanded>
      <NotchHeader layout={layout} left="Ready when you are" right={null} />
      <NotchBody shape={shape} reduced={false}>
        <button>Message</button>
      </NotchBody>
    </NotchSurface>
  );
  const { rerender } = render(shell({ width: 96, height: 36 }));
  const header = () => screen.getByText("Ready when you are");
  const body = () => screen.getByText("Message").parentElement!;
  expect(header().style.visibility).toBe("hidden");
  expect(body().style.visibility).toBe("hidden");
  await act(async () => springs.splice(0).forEach((finish) => finish()));
  expect(header().style.visibility).toBe("visible");
  rerender(shell({ width: 360, height: 112 }));
  expect(header().style.visibility).toBe("hidden");
  expect(body().style.visibility).toBe("hidden");
  expect(body().style.pointerEvents).toBe("none");
  await act(async () => springs.splice(0).forEach((finish) => finish()));
  expect(header().style.visibility).toBe("visible");
  expect(body().style.visibility).toBe("visible");
  expect(body().style.pointerEvents).toBe("auto");
});

it("reduced motion commits the clip in the same render as its content bounds", () => {
  const layout: NotchLayout = {
    displayId: 3,
    mode: "capsule",
    notch: null,
    growth: "down",
    maxShape: { width: 560, height: 220 },
  };
  const shell = (width: number, height: number) => (
    <NotchSurface layout={layout} shape={{ width, height }} expanded reduced />
  );
  const { container, rerender } = render(shell(96, 46));
  rerender(shell(360, 120));
  expect(
    container.querySelector<HTMLElement>(".notch-shape")!.style.clipPath
  ).toBe(shellClip(360, 120, 560, false));
});
