import { expect, it } from "vitest";

import { simulatorCrop, devicePoint } from "./crop";
it("crops the Simulator title bar and maps letterboxed pointer coordinates to screen pixels", () => {
  expect(simulatorCrop(400, 850, 0.5)).toEqual({
    x: 0,
    y: 50,
    width: 400,
    height: 800,
  });
  expect(simulatorCrop(400, 850, null)).toEqual({
    x: 0,
    y: 0,
    width: 400,
    height: 850,
  });
  const bounds = { left: 10, top: 20, width: 500, height: 800 };
  expect(devicePoint(260, 420, bounds, 400, 800)).toEqual({ x: 200, y: 400 });
  expect(devicePoint(-100, -100, bounds, 400, 800)).toEqual({ x: 0, y: 0 });
});
