import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  draftConversationKey,
  draftConversationRef,
} from "#shared/conversation-scope";

import { terminalRuntimeActions } from "../../stores/terminal-runtime-store";

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

beforeEach(() => {
  Object.defineProperty(window, "api", {
    configurable: true,
    value: { agent: { onEvent: vi.fn(() => vi.fn()) } },
  });
});

afterEach(() => terminalRuntimeActions.reset());

describe("TerminalPanel chrome", () => {
  it("fills the center panel and exposes compact terminal tab controls", () => {
    const onClose = vi.fn();
    const conversation = draftConversationRef("workspace");
    const conversationKey = draftConversationKey("workspace");
    terminalRuntimeActions.setOpen(conversationKey, true);
    const { container } = render(
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
    const { container } = render(
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

  it("omits the close control when the panel cannot be closed", () => {
    render(
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
