import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  draftConversationKey,
  draftConversationRef,
} from "#shared/conversation-scope";
import type { TerminalShellState } from "#shared/terminal-shells";

import { terminalRuntimeActions } from "../../stores/terminal-runtime-store";
import { resetTerminalViewsForTesting } from "../../terminals/terminal-views";

// The chrome is what these cover; a real grid needs a canvas, which jsdom has
// no answer for. `init` never resolving keeps every view inert.
vi.mock("ghostty-web", () => ({
  init: vi.fn(() => new Promise<void>(() => {})),
  Terminal: class {},
  FitAddon: class {},
  UrlRegexProvider: class {},
  OSC8LinkProvider: class {},
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { TerminalPanel } = await import("./terminal-panel");

const windowsShells: TerminalShellState = {
  selected: "system",
  effective: "cmd",
  statuses: [
    { id: "system", available: true },
    { id: "cmd", available: true },
    { id: "powershell", available: true },
    { id: "busybox", available: true },
    { id: "pwsh", available: false },
  ],
};

const getTerminalShellState = vi.fn(async () => windowsShells);
const setTerminalShell = vi.fn(async () => windowsShells);

// The panel lives inside the app's provider; the shell roster is a query.
const renderPanel = (ui: React.ReactElement): RenderResult =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>
  );

beforeEach(() => {
  getTerminalShellState.mockClear();
  setTerminalShell.mockClear();
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      agent: {
        onEvent: vi.fn(() => vi.fn()),
        getTerminalShellState,
        setTerminalShell,
        // The view starts a session as soon as it is built; these cover the
        // whole surface it can reach for.
        startTerminalSession: vi.fn(async () => ({
          success: false,
          created: false,
          initialOutput: "",
          error: "no terminal backend in tests",
          state: {},
        })),
        writeTerminalInput: vi.fn(async () => true),
        resizeTerminalSession: vi.fn(async () => true),
        hideTerminalSession: vi.fn(async () => true),
      },
    },
  });
});

afterEach(() => {
  resetTerminalViewsForTesting();
  terminalRuntimeActions.reset();
});

describe("TerminalPanel chrome", () => {
  it("fills the center panel and exposes compact terminal tab controls", () => {
    const onClose = vi.fn();
    const conversation = draftConversationRef("workspace");
    const conversationKey = draftConversationKey("workspace");
    terminalRuntimeActions.setOpen(conversationKey, true);
    const { container } = renderPanel(
      <TerminalPanel
        conversation={conversation}
        conversationKey={conversationKey}
        generation={null}
        onClose={onClose}
      />
    );

    const root = container.querySelector('[data-terminal-owner="center"]');
    const host = container.querySelector('[data-slot="terminal-host"]');

    const tabs = container.querySelector('[data-slot="terminal-tabs"]');

    expect(root?.classList.contains("flex")).toBe(true);
    expect(root?.classList.contains("h-full")).toBe(true);
    expect(root?.classList.contains("overflow-hidden")).toBe(true);
    expect(root?.classList.contains("bg-[#1e1e1e]")).toBe(true);
    expect(tabs?.classList.contains("h-7")).toBe(true);
    expect(host?.classList.contains("h-full")).toBe(true);
    expect(host?.classList.contains("w-full")).toBe(true);
    expect(host?.classList.contains("overflow-hidden")).toBe(true);
    expect(host?.classList.contains("bg-[#1e1e1e]")).toBe(true);
    expect(screen.getByRole("tab", { name: /Terminal 1/ })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "workspace.terminal.newTab" })
    ).toBeTruthy();

    const close = screen.getByRole("button", {
      name: "workspace.terminal.hide",
    });
    expect(close.getAttribute("data-id")).toBe("terminal-panel-close");

    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps each terminal host mounted while switching tabs", () => {
    const conversation = draftConversationRef("workspace");
    const conversationKey = draftConversationKey("workspace");
    terminalRuntimeActions.setOpen(conversationKey, true);
    const { container } = renderPanel(
      <TerminalPanel
        conversation={conversation}
        conversationKey={conversationKey}
        generation={null}
      />
    );

    const firstHost = container.querySelector('[data-slot="terminal-host"]');
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.terminal.newTab" })
    );

    expect(
      container.querySelectorAll('[data-slot="terminal-host"]')
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole("tab", { name: /Terminal 1/ }));
    expect(container.querySelector('[data-slot="terminal-host"]')).toBe(
      firstHost
    );
  });

  it("opens the last-used shell from + and only asks behind the chevron", async () => {
    const conversation = draftConversationRef("workspace");
    const conversationKey = draftConversationKey("workspace");
    terminalRuntimeActions.setOpen(conversationKey, true);
    renderPanel(
      <TerminalPanel
        conversation={conversation}
        conversationKey={conversationKey}
        generation={null}
      />
    );

    // The plain + neither asks nor rewrites the preference: main resolves it.
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.terminal.newTab" })
    );
    expect(setTerminalShell).not.toHaveBeenCalled();
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    const picker = await screen.findByRole("button", {
      name: "workspace.terminal.pickShell",
    });
    fireEvent.click(picker);

    const busybox = await screen.findByRole("menuitem", {
      name: "terminalShells.busybox.label",
    });
    fireEvent.click(busybox);

    // Picked: the tab is labelled with the shell, and the pick is stored so
    // the next automatically opened terminal comes back to it.
    await waitFor(() =>
      expect(setTerminalShell).toHaveBeenCalledWith("busybox")
    );
    expect(
      screen.getByRole("tab", { name: /terminalShells.busybox.label/ })
    ).toBeTruthy();
  });

  it("hides the shell picker when the roster has nothing to choose from", async () => {
    getTerminalShellState.mockResolvedValueOnce({
      selected: "system",
      effective: "system",
      statuses: [{ id: "system", available: true }],
    } as TerminalShellState);
    const conversationKey = draftConversationKey("workspace");
    terminalRuntimeActions.setOpen(conversationKey, true);
    renderPanel(
      <TerminalPanel
        conversation={draftConversationRef("workspace")}
        conversationKey={conversationKey}
        generation={null}
      />
    );

    await waitFor(() => expect(getTerminalShellState).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: "workspace.terminal.pickShell" })
    ).toBeNull();
  });

  it("omits the close control when the panel cannot be closed", () => {
    renderPanel(
      <TerminalPanel
        conversation={null}
        conversationKey={null}
        generation={null}
      />
    );

    expect(
      screen.queryByRole("button", { name: "workspace.terminal.hide" })
    ).toBeNull();
  });
});
