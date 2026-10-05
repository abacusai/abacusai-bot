/**
 * R1-T14: the app's shortcuts: exact bindings, the platform set only through
 * the provider, labels, rich-text guard, unique ownership, and the registry's
 * own Escape/F6 behaviour alongside.
 */
import { getHotkeyManager } from "@tanstack/react-hotkeys";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAppHotkey } from "#renderer/lib/hotkeys";
import {
  ActionBindingsContext,
  TerminalActionBindingsContext,
} from "#renderer/lib/keyboard/action-bindings";
import { resolveKeymap } from "#renderer/lib/keyboard/actions";
import { toHotkeyPlatform } from "#renderer/lib/platform";
import { Popover, PopoverContent, PopoverTrigger } from "#renderer/ui/popover";
import { Toaster, toast } from "#renderer/ui/toast";

import {
  dispatchAppHotkey,
  APP_HOTKEYS,
  AppHotkeys,
  AppHotkeysProvider,
  hotkeyLabel,
  type ShellActions,
} from "./hotkeys";

const actions = (): ShellActions &
  Record<string, ReturnType<typeof vi.fn> | boolean> => ({
  floatingOpen: true,
  openCommand: vi.fn(),
  newInArea: vi.fn(),
  togglePinned: vi.fn(),
  togglePanel: vi.fn(),
  openSettings: vi.fn(),
  closeFloating: vi.fn(),
});

const mount = (platformNode: string, extra?: React.ReactNode) => {
  const spies = actions();
  const view = render(
    <AppHotkeysProvider platform={toHotkeyPlatform(platformNode)}>
      <AppHotkeys actions={spies} />
      <textarea data-testid="plain" />
      <div data-testid="rich" contentEditable suppressContentEditableWarning />
      <div
        data-testid="rich-empty"
        {...({ contentEditable: "" } as object)}
        suppressContentEditableWarning
      />
      <div
        data-testid="plaintext"
        contentEditable="plaintext-only"
        suppressContentEditableWarning
      />
      <div data-hotkeys="text">
        <span data-testid="marked">text</span>
      </div>
      {extra}
    </AppHotkeysProvider>
  );
  return { spies, view };
};

const press = (
  target: Element | Document,
  key: string,
  code: string,
  modifiers: { meta?: boolean; ctrl?: boolean; alt?: boolean } = {}
): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", {
    key,
    code,
    metaKey: modifiers.meta ?? false,
    ctrlKey: modifiers.ctrl ?? false,
    altKey: modifiers.alt ?? false,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};

afterEach(() => undefined);

describe("app hotkeys", () => {
  it.each([
    ["darwin", { meta: true }],
    ["win32", { ctrl: true }],
    ["linux", { ctrl: true }],
  ] as const)(
    "on %s, Mod maps to the platform modifier from the provider",
    (platform, mod) => {
      const { spies } = mount(platform);
      press(document.body, "k", "KeyK", mod);
      press(document.body, "n", "KeyN", mod);
      press(document.body, "b", "KeyB", mod);
      press(document.body, ",", "Comma", mod);
      expect(spies.openCommand).toHaveBeenCalledOnce();
      expect(spies.newInArea).toHaveBeenCalledOnce();
      expect(spies.togglePinned).toHaveBeenCalledOnce();
      expect(spies.openSettings).toHaveBeenCalledOnce();
      // The other platform's modifier does nothing.
      const other = "meta" in mod ? { ctrl: true } : { meta: true };
      press(document.body, "k", "KeyK", other);
      expect(spies.openCommand).toHaveBeenCalledOnce();
    }
  );

  it("labels read ⌘ on macOS and Ctrl elsewhere", () => {
    expect(
      hotkeyLabel(APP_HOTKEYS.command, toHotkeyPlatform("darwin"))
    ).toContain("⌘");
    expect(
      hotkeyLabel(APP_HOTKEYS.command, toHotkeyPlatform("win32"))
    ).toContain("Ctrl");
    expect(
      hotkeyLabel(APP_HOTKEYS.command, toHotkeyPlatform("linux"))
    ).toContain("Ctrl");
  });

  it("keeps Mod+Alt+B and Mod+B apart; Option+B (∫) still matches", () => {
    const { spies } = mount("darwin");
    press(document.body, "b", "KeyB", { meta: true, alt: true });
    expect(spies.togglePanel).toHaveBeenCalledOnce();
    expect(spies.togglePinned).not.toHaveBeenCalled();
    press(document.body, "∫", "KeyB", { meta: true, alt: true });
    expect(spies.togglePanel).toHaveBeenCalledTimes(2);
    press(document.body, "b", "KeyB", { meta: true });
    expect(spies.togglePinned).toHaveBeenCalledOnce();
    expect(spies.togglePanel).toHaveBeenCalledTimes(2);
  });

  it("toggles in a textarea and cancels the event", () => {
    const { spies } = mount("darwin");
    const event = press(screen.getByTestId("plain"), "b", "KeyB", {
      meta: true,
    });
    expect(spies.togglePinned).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it.each(["rich", "rich-empty", "plaintext", "marked"])(
    "leaves Mod+B alone in %s (native bold keeps working)",
    (id) => {
      const { spies } = mount("darwin");
      const event = press(screen.getByTestId(id), "b", "KeyB", { meta: true });
      expect(spies.togglePinned).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    }
  );

  it("registers each app binding exactly once", () => {
    mount("darwin");
    const registrations = [...getHotkeyManager().registrations.state.values()];
    for (const binding of Object.entries(APP_HOTKEYS)
      .filter(([id]) => !["closeTab", "nextTab", "previousTab"].includes(id))
      .map(([, binding]) => binding)) {
      const count = registrations.filter((r) => r.hotkey === binding).length;
      expect(count, binding).toBe(1);
    }
  });

  it("lets Escape close an open popover and F6 reach the toasts", async () => {
    const { spies } = mount(
      "darwin",
      <>
        <Popover defaultOpen>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverContent>Inside</PopoverContent>
        </Popover>
        <Toaster />
      </>
    );
    expect(await screen.findByText("Inside")).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
      code: "Escape",
    });
    await waitFor(() => expect(screen.queryByText("Inside")).toBeNull());
    act(() => {
      toast.add({ title: "Saved" });
    });
    await screen.findByText("Saved");
    fireEvent.keyDown(window, { key: "F6", code: "F6" });
    await waitFor(() =>
      expect(
        document.activeElement?.closest('[data-slot="toast-viewport"]')
      ).not.toBeNull()
    );
    // App shortcuts still work.
    press(document.body, "k", "KeyK", { meta: true });
    expect(spies.openCommand).toHaveBeenCalledOnce();
  });
});

it("dispatches shell and dock identities after rebinding, while terminal targets keep their context", () => {
  const spies = actions();
  const close = vi.fn();
  const Dock = () => {
    useAppHotkey("Mod+W", close, { actionId: "close-tab" });
    return null;
  };
  const keymap = resolveKeymap(
    { "command-menu": "Mod+L", "close-tab": "Mod+E" },
    "windows"
  );
  render(
    <AppHotkeysProvider platform="windows">
      <ActionBindingsContext value={keymap.window}>
        <TerminalActionBindingsContext value={keymap.terminal}>
          <AppHotkeys actions={spies} />
          <Dock />
          <div data-hotkeys="terminal">
            <textarea data-testid="terminal-input" />
          </div>
        </TerminalActionBindingsContext>
      </ActionBindingsContext>
    </AppHotkeysProvider>
  );
  press(document.body, "k", "KeyK", { ctrl: true });
  expect(spies.openCommand).not.toHaveBeenCalled();
  press(document.body, "l", "KeyL", { ctrl: true });
  expect(spies.openCommand).toHaveBeenCalledOnce();
  press(document.body, "e", "KeyE", { ctrl: true });
  expect(close).toHaveBeenCalledOnce();
  const event = press(screen.getByTestId("terminal-input"), "n", "KeyN", {
    ctrl: true,
  });
  expect(event.defaultPrevented).toBe(false);
  expect(spies.newInArea).not.toHaveBeenCalled();
  act(() => {
    dispatchAppHotkey("command");
    dispatchAppHotkey("closeTab");
  });
  expect(spies.openCommand).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(2);
});
