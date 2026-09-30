import { expect, it, vi } from "vitest";

import { createNativePresenter } from "./native-presenter";
it("R4-T18 recovers the capture/hide/present chain and drops closed candidates", async () => {
  const order: string[] = [];
  const runtime = {
    capture: vi.fn(async () => {
      order.push("capture");
      throw Error("capture");
    }),
    hide: vi.fn(async () => {
      order.push("hide");
    }),
    present: vi.fn(async () => {
      order.push("present");
      return {};
    }),
  };
  const presenter = createNativePresenter(runtime as never);
  const c = (id: string) => ({
    id,
    lease: { conversationKey: "k", resourceId: id, generation: 1 } as never,
    visible: () => true,
    blocked: () => false,
    bounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
  });
  const one = presenter.register(c("one"));
  await presenter.refresh();
  const two = presenter.register(c("two"));
  await presenter.refresh();
  expect(order).toEqual(["present", "capture", "hide", "present"]);
  two();
  await presenter.refresh();
  expect(order.at(-1)).toBe("present");
  one();
  await presenter.refresh();
});
