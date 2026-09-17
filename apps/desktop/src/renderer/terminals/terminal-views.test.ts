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

import {
  terminalRuntimeActions,
  terminalRuntimeStore,
} from "../stores/terminal-runtime-store";

// Enough of a terminal to get the view through construction. jsdom has no
// canvas, so nothing here draws; what these cover is the registry and the
// lifecycle around it.
vi.mock("ghostty-web", () => ({
  init: vi.fn(async () => {}),
  Terminal: class {
    cols = 80;
    rows = 24;
    wasmTerm = {};
    renderer = { getMetrics: () => ({ width: 10, height: 20 }) };
    open(): void {}
    loadAddon(): void {}
    dispose(): void {}
    reset(): void {}
    write(): void {}
    resize(): void {}
    focus(): void {}
    getViewportY(): number {
      return 0;
    }
    registerLinkProvider(): void {}
    attachCustomKeyEventHandler(): void {}
    attachCustomWheelEventHandler(): void {}
    onData(): void {}
  },
  FitAddon: class {
    fit(): void {}
    proposeDimensions(): undefined {
      return undefined;
    }
  },
  UrlRegexProvider: class {},
  OSC8LinkProvider: class {},
}));

const {
  acquireTerminalView,
  closeTerminalView,
  closeTerminalViews,
  rekeyTerminalViews,
  resetTerminalViewsForTesting,
} = await import("./terminal-views");

const hideTerminalSession = vi.fn(async () => true);
/** The renderer's end of the agent event stream, so a test can fire one. */
let emitAgentEvent: ((event: Record<string, unknown>) => void) | null = null;

beforeEach(() => {
  resetTerminalViewsForTesting();
  hideTerminalSession.mockClear();
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      agent: {
        onEvent: vi.fn((listener: (event: Record<string, unknown>) => void) => {
          emitAgentEvent = listener;
          return () => {
            emitAgentEvent = null;
          };
        }),
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

  it("takes its tab with it when the shell exits, with nobody listening", async () => {
    terminalRuntimeActions.setOpen(draft, true);
    const tab = terminalRuntimeStore.get().scopes[draft]?.tabs[0]?.id ?? "";
    const view = acquireTerminalView({
      conversationKey: draft,
      conversation: draftRef,
      terminalId: tab,
    });
    // Let the session start so the view knows its generation.
    await vi.waitFor(() => expect(emitAgentEvent).not.toBeNull());

    // No panel is mounted, so nothing has registered an exit listener — which
    // is the case this covers: the tab used to survive with everything the
    // dead shell had printed, and the next terminal opened on top of it.
    emitAgentEvent!({
      type: "terminal-exited",
      terminalId: tab,
      conversationKey: draft,
      generation: 1,
    });

    expect(terminalRuntimeStore.get().scopes[draft]?.tabs).toHaveLength(0);
    expect(
      acquireTerminalView({
        conversationKey: draft,
        conversation: draftRef,
        terminalId: tab,
      })
    ).not.toBe(view);
  });
});
