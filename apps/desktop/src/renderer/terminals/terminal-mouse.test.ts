/**
 * What the terminal tells a program about the pointer.
 *
 * The bug this answers: a wheel turn arrived at `less` as cursor keys, because
 * ghostty-web reports no mouse at all and falls back to the pre-wheel
 * behaviour on the alternate screen. Every case here is a way of getting that
 * wrong again — reporting when nothing asked, staying silent when something
 * did, or sending a sequence the program cannot read.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { encodeMouse, installMouseReporting } from "./terminal-mouse";

/** Modes a program has switched on, as `getMode` answers them. */
let modes: Set<number>;
let sent: string[];
let element: HTMLElement;

const CELL = { width: 10, height: 20 };

const terminal = () =>
  ({
    cols: 80,
    rows: 24,
    input: (data: string, wasUserInput?: boolean) => {
      // Only user input reaches the shell; anything else would be printed.
      expect(wasUserInput).toBe(true);
      sent.push(data);
    },
    attachCustomWheelEventHandler: (
      handler?: (event: WheelEvent) => boolean
    ) => {
      wheelHandler = handler ?? null;
    },
    renderer: { getMetrics: () => CELL },
    wasmTerm: {
      getMode: (mode: number) => modes.has(mode),
      hasMouseTracking: () =>
        modes.has(1000) || modes.has(1002) || modes.has(1003),
    },
  }) as never;

let wheelHandler: ((event: WheelEvent) => boolean) | null = null;

const at = (col: number, row: number) => ({
  clientX: (col - 1) * CELL.width + 1,
  clientY: (row - 1) * CELL.height + 1,
});

const wheel = (init: WheelEventInit): boolean =>
  wheelHandler?.(new WheelEvent("wheel", { deltaMode: 0, ...init })) ?? false;

const mouse = (type: string, init: MouseEventInit): void => {
  element.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  );
};

beforeEach(() => {
  modes = new Set<number>();
  sent = [];
  wheelHandler = null;
  element = document.createElement("div");
  const canvas = document.createElement("canvas");
  // jsdom gives every element a zero rect; the pointer maths needs a real one.
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 480 }) as DOMRect;
  element.append(canvas);
  document.body.append(element);
  installMouseReporting(terminal(), element);
});

describe("the encoding", () => {
  it("writes SGR when the program asked for it", () => {
    expect(encodeMouse(true, 0, 12, 7, false)).toBe("[<0;12;7M");
    // Release keeps its button in SGR, and says so with a lowercase m.
    expect(encodeMouse(true, 0, 12, 7, true)).toBe("[<0;12;7m");
  });

  it("falls back to X10, which cannot name the button it let go", () => {
    expect(encodeMouse(false, 0, 1, 1, false)).toBe("[M !!");
    // Button 3 is "something was released"; the modifier bits survive it.
    expect(encodeMouse(false, 16, 1, 1, true)).toBe(
      `[M${String.fromCharCode(16 + 3 + 32, 33, 33)}`
    );
  });

  it("says nothing rather than lying past X10's reach", () => {
    expect(encodeMouse(false, 0, 224, 1, false)).toBeNull();
    // SGR has no such limit.
    expect(encodeMouse(true, 0, 224, 1, false)).toBe("[<0;224;1M");
  });
});

describe("the wheel", () => {
  it("is left to the terminal when no program is tracking", () => {
    expect(wheel({ deltaY: -100 })).toBe(false);
    expect(sent).toEqual([]);
  });

  it("is a wheel, not a pair of cursor keys, when one is", () => {
    modes.add(1000).add(1006);

    expect(wheel({ deltaY: -CELL.height * 2, ...at(3, 4) })).toBe(true);

    // 64 is wheel-up, at the cell under the pointer, twice for two lines.
    expect(sent).toEqual(["[<64;3;4M", "[<64;3;4M"]);
  });

  it("adds up trackpad deltas instead of dropping them", () => {
    modes.add(1000).add(1006);

    // A fifth of a line at a time: nothing until they make one.
    for (let tick = 0; tick < 4; tick += 1) wheel({ deltaY: CELL.height / 5 });
    expect(sent).toEqual([]);

    wheel({ deltaY: CELL.height / 5 });
    expect(sent).toEqual(["[<65;1;1M"]);
  });

  it("carries modifiers and reports sideways scrolling", () => {
    modes.add(1000).add(1006);

    wheel({ deltaX: CELL.width * 1, ctrlKey: true });

    // 67 is wheel-right; 16 is control.
    expect(sent).toEqual(["[<83;1;1M"]);
  });

  it("leaves the wheel alone while shift is held, so the view still scrolls", () => {
    modes.add(1000).add(1006);

    expect(wheel({ deltaY: -100, shiftKey: true })).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("buttons and motion", () => {
  it("reports press and release at the cell under the pointer", () => {
    modes.add(1000).add(1006);

    mouse("mousedown", { button: 0, ...at(5, 2) });
    mouse("mouseup", { button: 0, ...at(5, 2) });

    expect(sent).toEqual(["[<0;5;2M", "[<0;5;2m"]);
  });

  it("stays quiet about motion unless the program asked for it", () => {
    modes.add(1000).add(1006);

    mouse("mousedown", { button: 0, ...at(1, 1) });
    mouse("mousemove", { ...at(4, 1) });

    // 1000 is clicks only: a drag is the terminal's to select with.
    expect(sent).toEqual(["[<0;1;1M"]);
  });

  it("reports a drag once per cell under button tracking", () => {
    modes.add(1002).add(1006);

    mouse("mousedown", { button: 0, ...at(1, 1) });
    mouse("mousemove", { ...at(2, 1) });
    // Same cell, a few pixels along: nothing new to say.
    mouse("mousemove", { clientX: 15, clientY: 1 });
    mouse("mousemove", { ...at(3, 1) });

    expect(sent).toEqual([
      "[<0;1;1M",
      // 32 is the motion bit, on top of the held button.
      "[<32;2;1M",
      "[<32;3;1M",
    ]);
  });

  it("hands the pointer back to the user while shift is held", () => {
    modes.add(1002).add(1006);

    mouse("mousedown", { button: 0, shiftKey: true, ...at(2, 2) });

    expect(sent).toEqual([]);
  });
});

describe("the pointer", () => {
  it("is an arrow while a program owns the mouse, and text otherwise", () => {
    mouse("mousemove", { ...at(2, 2) });
    // Nothing tracking: the library's I-beam is left alone.
    expect(element.style.cursor).toBe("");

    modes.add(1000).add(1006);
    mouse("mousemove", { ...at(3, 2) });
    expect(element.style.cursor).toBe("default");
  });
});

describe("focus", () => {
  it("is reported only to a program that asked", () => {
    element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(sent).toEqual([]);

    modes.add(1004);
    element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

    expect(sent).toEqual(["[I", "[O"]);
  });
});

describe("cleaning up", () => {
  it("stops reporting when the terminal goes", () => {
    modes.add(1000).add(1006);
    // Its own element, so the installation from beforeEach is not listening
    // to it and cannot answer in its place.
    const other = document.createElement("div");
    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 480 }) as DOMRect;
    other.append(canvas);
    document.body.append(other);

    const stop = installMouseReporting(terminal(), other);
    other.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    );
    expect(sent).toHaveLength(1);

    stop();
    other.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    );

    expect(sent).toHaveLength(1);
    expect(wheelHandler).toBeNull();
  });

  it("says nothing for a grid that has no size yet", () => {
    modes.add(1000).add(1006);
    // A collapsed panel: no cell to name, so no coordinates to report. Its
    // own element again, or the installation from beforeEach answers for it.
    const collapsed = document.createElement("div");
    collapsed.append(document.createElement("canvas"));
    document.body.append(collapsed);
    const stop = installMouseReporting(
      {
        ...(terminal() as unknown as Record<string, unknown>),
        renderer: { getMetrics: () => ({ width: 0, height: 0 }) },
      } as never,
      collapsed
    );

    collapsed.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    );

    expect(sent).toEqual([]);
    stop();
  });
});
