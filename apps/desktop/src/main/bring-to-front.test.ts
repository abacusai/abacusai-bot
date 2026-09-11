/**
 * The shared reveal. Its whole job is to let a service ask for the window
 * without importing the entry module, so what matters is that it is safe to
 * call before anything is installed and after the window is gone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  bringToFront,
  dismissOnEscape,
  parentWindow,
  presentAsDialog,
  setBringToFront,
  setMainWindow,
} from "./bring-to-front";

beforeEach(() => {
  setBringToFront(null);
  setMainWindow(null);
});

describe("bringToFront", () => {
  it("does nothing before a window has installed one", () => {
    expect(() => bringToFront()).not.toThrow();
  });

  it("reveals once installed", () => {
    const reveal = vi.fn();
    setBringToFront(reveal);

    bringToFront();
    bringToFront();

    expect(reveal).toHaveBeenCalledTimes(2);
  });

  it("goes quiet again when the window clears it", () => {
    const reveal = vi.fn();
    setBringToFront(reveal);
    setBringToFront(null);

    bringToFront();

    expect(reveal).not.toHaveBeenCalled();
  });
});

/**
 * A connector's login window names this as its `parent` so it shares the app's
 * Space. Left top-level it opened a Space of its own whenever the app was full
 * screen, and hiding it after login left the user on an empty one.
 */
describe("parentWindow", () => {
  const window = (destroyed = false): Parameters<typeof setMainWindow>[0] =>
    ({ isDestroyed: () => destroyed }) as never;

  it("is undefined before there is a window", () => {
    expect(parentWindow()).toBeUndefined();
  });

  it("hands back the window once there is one", () => {
    const win = window();
    setMainWindow(win);

    expect(parentWindow()).toBe(win);
  });

  it("refuses a destroyed window — no parent beats a dead one", () => {
    setMainWindow(window(true));

    expect(parentWindow()).toBeUndefined();
  });

  it("is undefined again once the window clears itself", () => {
    setMainWindow(window());
    setMainWindow(null);

    expect(parentWindow()).toBeUndefined();
  });
});

/**
 * The reveal. Connectors boot before the main window exists, so the parent
 * they name at construction is often nobody — this is what makes the login
 * window a child of the app by the time it is on screen.
 */
describe("presentAsDialog", () => {
  const mainWindow = (bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Parameters<typeof setMainWindow>[0] =>
    // isFullScreen: the macOS full-screen branch asks before adopting; a
    // parent that cannot answer is a crash the real one never has.
    ({
      isDestroyed: () => false,
      isFullScreen: () => false,
      getBounds: () => bounds,
    }) as never;

  const dialog = (
    own: { width: number; height: number },
    { visible = false } = {}
  ) => {
    let parent: unknown = null;
    const setBounds = vi.fn();
    const show = vi.fn(() => {
      visible = true;
    });
    const focus = vi.fn();
    // Every adoption, in order, against whether the window was on screen for
    // it: macOS attaches a child window only while it is visible.
    const adoptions: { parent: unknown; visible: boolean }[] = [];
    return {
      win: {
        getParentWindow: () => parent,
        setParentWindow: (p: unknown) => {
          parent = p;
          adoptions.push({ parent: p, visible });
        },
        getBounds: () => ({ x: 0, y: 0, ...own }),
        setBounds,
        isVisible: () => visible,
        show,
        focus,
      } as never,
      currentParent: () => parent,
      adoptions,
      setBounds,
      show,
      focus,
    };
  };

  it("shows the window even with no main window to hang off", () => {
    const { win, currentParent, setBounds, show, focus } = dialog({
      width: 1100,
      height: 760,
    });

    presentAsDialog(win);

    expect(currentParent()).toBeNull();
    expect(setBounds).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
  });

  it("adopts the main window and centres over it", () => {
    const main = mainWindow({ x: 100, y: 50, width: 2000, height: 1200 });
    setMainWindow(main);
    const { win, currentParent, setBounds, show } = dialog({
      width: 1100,
      height: 760,
    });

    presentAsDialog(win);

    expect(currentParent()).toBe(main);
    expect(show).toHaveBeenCalled();
    expect(setBounds).toHaveBeenCalledWith({
      width: 1100,
      height: 760,
      x: 100 + (2000 - 1100) / 2,
      y: 50 + (1200 - 760) / 2,
    });
  });

  it("adopts before showing — macOS attaches the child at the show", () => {
    const main = mainWindow({ x: 0, y: 0, width: 2000, height: 1200 });
    setMainWindow(main);
    const { win, adoptions } = dialog({ width: 1100, height: 760 });

    presentAsDialog(win);

    expect(adoptions).toEqual([{ parent: main, visible: false }]);
  });

  it("leaves a window that is already up alone rather than re-showing it", () => {
    setMainWindow(mainWindow({ x: 0, y: 0, width: 2000, height: 1200 }));
    const { win, show, focus } = dialog(
      { width: 1100, height: 760 },
      { visible: true }
    );

    presentAsDialog(win);

    expect(show).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
  });

  it("shrinks a window wider than its parent — it has to fit", () => {
    setMainWindow(mainWindow({ x: 0, y: 0, width: 900, height: 600 }));
    const { win, setBounds } = dialog({ width: 1100, height: 760 });

    presentAsDialog(win);

    expect(setBounds).toHaveBeenCalledWith({
      width: 860,
      height: 560,
      x: 20,
      y: 20,
    });
  });

  /** Run `fn` with process.platform reporting darwin, restored afterwards. */
  const onDarwin = (fn: () => void): void => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      fn();
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  };

  /** A main window in macOS full screen, with a controllable transition. */
  const fullScreenMain = () => {
    let fullScreen = true;
    const handlers = new Map<string, () => void>();
    const setFullScreen = vi.fn((value: boolean) => {
      fullScreen = value;
    });
    return {
      win: {
        isDestroyed: () => false,
        getBounds: () => ({ x: 0, y: 0, width: 2000, height: 1200 }),
        isFullScreen: () => fullScreen,
        setFullScreen,
        once: (event: string, fn: () => void) => {
          handlers.set(event, fn);
        },
      } as never,
      setFullScreen,
      leave: () => handlers.get("leave-full-screen")?.(),
    };
  };

  it("steps a full-screen app out of full screen, and reveals only after the transition (macOS)", () => {
    onDarwin(() => {
      const main = fullScreenMain();
      setMainWindow(main.win);
      const { win, show, focus, currentParent } = dialog({
        width: 1100,
        height: 760,
      });

      presentAsDialog(win);

      // Mid-transition is where AppKit falls over: nothing happens yet.
      expect(main.setFullScreen).toHaveBeenCalledWith(false);
      expect(show).not.toHaveBeenCalled();
      expect(currentParent()).toBeNull();

      main.leave();

      expect(currentParent()).toBe(main.win);
      expect(show).toHaveBeenCalled();
      expect(focus).toHaveBeenCalled();
    });
  });

  it("reveals a windowed app's dialog immediately, macOS included", () => {
    onDarwin(() => {
      const main = fullScreenMain();
      main.setFullScreen(false);
      setMainWindow(main.win);
      const { win, show } = dialog({ width: 1100, height: 760 });

      presentAsDialog(win);

      expect(show).toHaveBeenCalled();
    });
  });
});

/**
 * The way out of the login window. It has no close button of its own, so Esc
 * (and Cmd/Ctrl+W) must hide it, and the app has to be raised behind it — a
 * hidden window hands focus to whatever the OS pleases, which is not
 * necessarily the app the user was in.
 */
describe("dismissOnEscape", () => {
  type InputHandler = (
    event: { preventDefault: () => void },
    input: {
      type: string;
      key: string;
      meta?: boolean;
      control?: boolean;
    }
  ) => void;

  const loginWindow = (visible = true) => {
    const contentsHandlers = new Map<string, (...args: never[]) => void>();
    const windowHandlers = new Map<string, () => void>();
    const hide = vi.fn();
    const executeJavaScript = vi.fn().mockResolvedValue(undefined);
    const win = {
      isVisible: () => visible,
      hide,
      on: (event: string, fn: () => void) => {
        windowHandlers.set(event, fn);
      },
      webContents: {
        executeJavaScript,
        on: (event: string, fn: (...args: never[]) => void) => {
          contentsHandlers.set(event, fn);
        },
      },
    } as never;
    dismissOnEscape(win);
    const press = (input: Parameters<InputHandler>[1]) => {
      const preventDefault = vi.fn();
      (
        contentsHandlers.get("before-input-event") as InputHandler | undefined
      )?.({ preventDefault }, input);
      return preventDefault;
    };
    return { hide, press, executeJavaScript, contentsHandlers, windowHandlers };
  };

  it("hides on Escape while visible", () => {
    const { hide, press } = loginWindow();

    const preventDefault = press({ type: "keyDown", key: "Escape" });

    expect(hide).toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalled();
  });

  it("raises the app behind the window it just hid", () => {
    const reveal = vi.fn();
    setBringToFront(reveal);
    const { press } = loginWindow();

    press({ type: "keyDown", key: "Escape" });

    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("hides on the close chord", () => {
    const { hide, press } = loginWindow();

    press({ type: "keyDown", key: "w", meta: true });

    expect(hide).toHaveBeenCalled();
  });

  it("ignores other keys, key-ups, and a plain w", () => {
    const { hide, press } = loginWindow();

    press({ type: "keyDown", key: "Enter" });
    press({ type: "keyUp", key: "Escape" });
    press({ type: "keyDown", key: "w" });

    expect(hide).not.toHaveBeenCalled();
  });

  it("leaves a hidden window alone — the driver types into it constantly", () => {
    const { hide, press } = loginWindow(false);

    press({ type: "keyDown", key: "Escape" });

    expect(hide).not.toHaveBeenCalled();
  });

  it("puts the Cancel pill on the page when the window shows", () => {
    const { executeJavaScript, windowHandlers } = loginWindow();

    windowHandlers.get("show")?.();

    expect(executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("abacus-dismiss-hint"),
      true
    );
  });

  it("never decorates a page nobody is looking at", () => {
    const { executeJavaScript, contentsHandlers } = loginWindow(false);

    (contentsHandlers.get("did-finish-load") as (() => void) | undefined)?.();

    expect(executeJavaScript).not.toHaveBeenCalled();
  });

  it("hides when the page's Cancel pill reports a click", () => {
    const { hide, contentsHandlers } = loginWindow();
    const onConsole = contentsHandlers.get("console-message") as
      | ((event: { message: string }) => void)
      | undefined;

    onConsole?.({ message: "the page talking to itself" });
    expect(hide).not.toHaveBeenCalled();

    onConsole?.({ message: "abacus:cancel-connector-login" });
    expect(hide).toHaveBeenCalled();
  });
});
