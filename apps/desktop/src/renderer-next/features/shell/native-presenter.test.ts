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
it("hides the old owner after the capture deadline even when capture never resolves", async () => {
  vi.useFakeTimers();
  const runtime = {
    capture: vi.fn(() => new Promise(() => {})),
    hide: vi.fn(async () => {}),
    present: vi.fn(async () => ({})),
  };
  const presenter = createNativePresenter(runtime as never);
  const candidate = (id: string) => ({
    id,
    lease: { conversationKey: "k", resourceId: id, generation: 1 } as never,
    bounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    visible: () => true,
    blocked: () => false,
  });
  const one = presenter.register(candidate("one"));
  await presenter.refresh();
  const two = presenter.register(candidate("two"));
  const finished = presenter.refresh();
  await vi.advanceTimersByTimeAsync(501);
  await finished;
  expect(runtime.hide).toHaveBeenCalledWith(
    expect.objectContaining({ presentationId: "one" })
  );
  expect(presenter.owner.state).toBe("two");
  one();
  two();
  const cleanup = presenter.refresh();
  await vi.advanceTimersByTimeAsync(501);
  await cleanup;
  vi.useRealTimers();
});
it("equivalent background re-registration preserves the user's selected owner", async () => {
  const presenter = createNativePresenter({
    capture: async () => ({ dataUrl: null }),
    hide: async () => {},
    present: async () => ({}),
  } as never);
  const candidate = (id: string) => ({
    id,
    lease: { conversationKey: "k", resourceId: id, generation: 1 } as never,
    visible: () => true,
    blocked: () => false,
    bounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
  });
  const a = presenter.register(candidate("A"));
  const b = presenter.register(candidate("B"));
  await presenter.activate("A");
  const replacement = presenter.register(candidate("B"));
  await presenter.refresh();
  expect(presenter.owner.state).toBe("A");
  a();
  b();
  replacement();
  await presenter.refresh();
});
