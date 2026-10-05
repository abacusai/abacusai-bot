import { expect, it, vi } from "vitest";

import { createNotchView, createNotchWindow } from "./window";
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    BaseWindow: class extends EventEmitter {
      size = [300, 100];
      isDestroyed = () => false;
      getContentSize = () => this.size;
      setBounds() {}
      setAlwaysOnTop() {}
      setVisibleOnAllWorkspaces() {}
      setIgnoreMouseEvents() {}
      contentView = Object.assign(new EventEmitter(), {
        getBounds: () => ({
          x: 0,
          y: 0,
          width: this.size[0],
          height: this.size[1],
        }),
        children: [] as unknown[],
        addChildView: (view: unknown) => this.contentView.children.push(view),
        removeChildView: (view: unknown) => {
          this.contentView.children = this.contentView.children.filter(
            (v) => v !== view
          );
        },
      });
    },
    WebContentsView: class {
      setBounds = vi.fn();
      setBackgroundColor() {}
      webContents = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        setWindowOpenHandler() {},
      });
    },
  };
});
it("resize fits the promoted child automatically after the original is removed", () => {
  const { win, view } = createNotchWindow(
    "darwin",
    { bounds: { x: 0, y: 0, width: 300, height: 100 } } as never,
    ""
  );
  const replacement = createNotchView("");
  win.contentView.removeChildView(view);
  win.contentView.addChildView(replacement);
  (win as any).size = [500, 200];
  (win as any).emit("resize");
  expect(replacement.setBounds).toHaveBeenCalledWith({
    x: 0,
    y: 0,
    width: 500,
    height: 200,
  });
  expect(view.setBounds).toHaveBeenCalledTimes(1);
});

it("fits the promoted child when native content bounds settle after resize", () => {
  const { win, view } = createNotchWindow(
    "linux",
    { bounds: { x: 0, y: 0, width: 300, height: 100 } } as never,
    ""
  );
  const replacement = createNotchView("");
  win.contentView.removeChildView(view);
  win.contentView.addChildView(replacement);
  (win as any).emit("resize");
  (win as any).size = [500, 200];
  win.contentView.emit("bounds-changed");
  expect(replacement.setBounds).toHaveBeenLastCalledWith({
    x: 0,
    y: 0,
    width: 500,
    height: 200,
  });
  expect(view.setBounds).toHaveBeenCalledTimes(1);
});
