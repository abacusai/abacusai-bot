/**
 * Who owns a terminal, and for how long.
 *
 * The panel used to build one from inside an effect, which is how a render
 * came to spawn a shell. A view is now a thing with an identity — one per
 * conversation and tab — and these are the rules that identity has to keep,
 * because each one it breaks is a PTY nobody can see and nobody kills.
 *
 * The grid itself is not exercised here: it needs a canvas, and jsdom has
 * none. That part is src/main/ghostty-scrollback.browser.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  draftConversationKey,
  draftConversationRef,
  sessionConversationKey,
  sessionConversationRef,
} from "#shared/conversation-scope";

// A grid needs a canvas and jsdom has none; every rule below is about the
// registry, not the terminal.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    unicode = { activeVersion: "6" };
    cols = 80;
    rows = 24;
    open(): void {}
    loadAddon(): void {}
    dispose(): void {}
    reset(): void {}
    write(): void {}
    resize(): void {}
    focus(): void {}
    attachCustomKeyEventHandler(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => {} };
    }
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
    proposeDimensions(): undefined {
      return undefined;
    }
  },
}));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-clipboard", () => ({ ClipboardAddon: class {} }));

const {
  acquireTerminalView,
  closeTerminalView,
  closeTerminalViews,
  rekeyTerminalViews,
  resetTerminalViewsForTesting,
} = await import("./terminal-views");

const hideTerminalSession = vi.fn(async () => true);

beforeEach(() => {
  resetTerminalViewsForTesting();
  hideTerminalSession.mockClear();
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      agent: {
        onEvent: vi.fn(() => vi.fn()),
        startTerminalSession: vi.fn(async () => ({
          success: true,
          created: true,
          initialOutput: "",
          state: { generation: 1 },
        })),
        writeTerminalInput: vi.fn(async () => true),
        resizeTerminalSession: vi.fn(async () => true),
        hideTerminalSession,
      },
    },
  });
});

const draft = draftConversationKey("workspace");
const draftRef = draftConversationRef("workspace");

describe("the terminal a tab owns", () => {
  it("is the same one however often it is asked for", () => {
    const first = acquireTerminalView({
      conversationKey: draft,
      conversation: draftRef,
      terminalId: "terminal-1",
    });
    const second = acquireTerminalView({
      conversationKey: draft,
      conversation: draftRef,
      terminalId: "terminal-1",
    });

    // The whole point: a re-render asks again and gets what already exists,
    // rather than a second terminal and a second shell.
    expect(second).toBe(first);
    expect(second.element).toBe(first.element);
  });

  it("is a different one per tab", () => {
    const one = acquireTerminalView({
      conversationKey: draft,
      conversation: draftRef,
      terminalId: "terminal-1",
    });
    const two = acquireTerminalView({
      conversationKey: draft,
      conversation: draftRef,
      terminalId: "terminal-2",
    });

    expect(two).not.toBe(one);
  });

  it("is forgotten when the tab closes, so the next open is a fresh shell", () => {
    const first = acquireTerminalView({
      conversationKey: draft,
      conversation: draftRef,
      terminalId: "terminal-1",
    });
    closeTerminalView(draft, "terminal-1");
    const second = acquireTerminalView({
      conversationKey: draft,
      conversation: draftRef,
      terminalId: "terminal-1",
    });

    expect(second).not.toBe(first);
  });

  it("follows its conversation from draft to session", () => {
    const view = acquireTerminalView({
      conversationKey: draft,
      conversation: draftRef,
      terminalId: "terminal-1",
    });
    const session = sessionConversationKey("workspace", "chat");

    rekeyTerminalViews(
      draft,
      session,
      sessionConversationRef("workspace", "chat")
    );

    // Main moves the PTY across the promotion. Asking under the session key
    // has to find the terminal that was already running, or the panel starts
    // a second shell beside the first.
    expect(
      acquireTerminalView({
        conversationKey: session,
        conversation: sessionConversationRef("workspace", "chat"),
        terminalId: "terminal-1",
      })
    ).toBe(view);
    expect(view.conversationKey).toBe(session);
  });

  it("goes away with the conversation it belonged to", () => {
    const view = acquireTerminalView({
      conversationKey: draft,
      conversation: draftRef,
      terminalId: "terminal-1",
    });
    const other = draftConversationKey("other-workspace");
    const survivor = acquireTerminalView({
      conversationKey: other,
      conversation: draftConversationRef("other-workspace"),
      terminalId: "terminal-1",
    });

    closeTerminalViews(draft);

    expect(
      acquireTerminalView({
        conversationKey: draft,
        conversation: draftRef,
        terminalId: "terminal-1",
      })
    ).not.toBe(view);
    // Another conversation's terminal is none of its business.
    expect(
      acquireTerminalView({
        conversationKey: other,
        conversation: draftConversationRef("other-workspace"),
        terminalId: "terminal-1",
      })
    ).toBe(survivor);
  });
});
