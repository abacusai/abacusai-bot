import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef, type JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentMode, AgentStatus } from "#shared/agent-types";
import type { PrInfo } from "#shared/contracts";
import type { ModelAvailability } from "#shared/models";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      if (key === "workspace.prStatus.label") return `PR #${values?.number}`;
      if (key === "workspace.prStatus.open")
        return `Open PR #${values?.number}`;
      if (key === "workspace.prStatus.none") return "No PR";
      if (key === "workspace.prStatus.noneDescription") {
        return "No pull request for the current branch";
      }
      return key;
    },
  }),
}));

vi.mock("./branch-picker", () => ({
  BranchPicker: () => (
    <button data-id="local-code-branch-selector">main</button>
  ),
}));
vi.mock("./composer-tasks", () => ({
  ComposerTasksBadge: () => null,
  ComposerTasksDrawer: () => null,
}));
vi.mock("./file-mention-picker", () => ({ FileMentionPicker: () => null }));
// The microphone needs a real browser; the hook is stubbed to hand text back.
const dictation = vi.hoisted(() => ({
  onText: null as ((text: string) => void) | null,
}));
vi.mock("../../voice/use-dictation", () => ({
  useDictation: (onText: (text: string) => void) => {
    dictation.onText = onText;
    return {
      phase: "idle",
      level: 0,
      download: null,
      error: null,
      toggle: () => {},
      cancel: () => {},
    };
  },
}));
vi.mock("./model-picker", () => ({ ModelPicker: () => null }));
vi.mock("./runtime-mode-picker", () => ({
  RuntimeModePicker: () => <button type="button">Permission mode</button>,
}));
vi.mock("./slash-command-menu", () => ({ SlashCommandMenu: () => null }));
vi.mock("./worktree-picker", () => ({
  WorktreePicker: () => (
    <button data-id="local-code-worktree-selector">Current checkout</button>
  ),
}));

const { ChatComposer, PrStatusPill } = await import("./chat-composer");

const openExternal = vi.fn<(url: string) => Promise<void>>();

const queryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

const configuredModel = {
  id: "test:model",
  label: "Test",
  provider: "test",
  tier: "default" as const,
  configured: true,
};

const renderComposer = (
  hasConversation: boolean,
  {
    inputValue = "",
    canSend = false,
    worktreeMutationPending = false,
    models = [configuredModel],
    onInputValueChange = () => {},
    activeWorkspaceId = "workspace-1",
    onAddWorkspace = () => {},
    onSend = async () => {},
    compact = false,
    canSelectMode = true,
    agentStatus = AgentStatus.Idle,
    pendingPermission = null,
    isSendLoading = false,
    onStop = () => {},
  }: {
    isSendLoading?: boolean;
    onStop?: () => void;
    inputValue?: string;
    canSend?: boolean;
    worktreeMutationPending?: boolean;
    // `null` is "catalog not loaded yet" and reaches the component as
    // undefined. Passing `undefined` here would pick up the default instead,
    // which is a configured model — the opposite of what that case means.
    models?: ModelAvailability[] | null;
    onInputValueChange?: (value: string) => void;
    activeWorkspaceId?: string | null;
    onAddWorkspace?: () => void;
    onSend?: () => Promise<void>;
    compact?: boolean;
    canSelectMode?: boolean;
    agentStatus?: AgentStatus;
    pendingPermission?: {
      permissionId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
      workspaceId: string;
      sessionId: string;
    } | null;
  } = {}
): JSX.Element => {
  render(
    <QueryClientProvider client={queryClient()}>
      <ChatComposer
        historyScope="session-1"
        inputRef={createRef<HTMLTextAreaElement>()}
        inputValue={inputValue}
        onInputValueChange={onInputValueChange}
        onSend={onSend}
        onStop={onStop}
        isSendLoading={isSendLoading}
        isStreaming={false}
        canSend={canSend}
        models={models ?? undefined}
        selectedModelValue="test:model"
        onSelectModel={() => {}}
        selectedModeValue={AgentMode.Normal}
        onSelectMode={() => {}}
        activeWorkspaceId={activeWorkspaceId}
        worktrees={[
          {
            id: "workspace-1",
            name: "project",
            path: "/tmp/project",
            branch: "main",
            isCurrent: true,
            isManaged: false,
          },
        ]}
        worktreeEnvironment={{ kind: "current" }}
        worktreeMutationPending={worktreeMutationPending}
        onSelectWorktreeEnvironment={() => {}}
        onAddWorkspace={onAddWorkspace}
        hasConversation={hasConversation}
        workspaceRoot="/tmp/project"
        agentStatus={agentStatus}
        pendingPermission={pendingPermission}
        compact={compact}
        canSelectMode={canSelectMode}
      />
    </QueryClientProvider>
  );
  return <></>;
};

const pullRequest: PrInfo = {
  number: 315,
  url: "https://github.com/abacusai/abacusai-bot/pull/315",
  title: "Renderer redesign",
  reviewState: "pending",
  additions: 20,
  deletions: 4,
  ciStatus: "success",
  checks: [],
  approvedCount: 0,
  changesRequestedCount: 0,
  reviewRequestedCount: 1,
};

beforeEach(() => {
  openExternal.mockResolvedValue();
  (window as unknown as { api: unknown }).api = {
    getHomeDir: async () => "/home/test",
    openExternal,
    agent: {
      getGitBranches: async () => ({
        success: true,
        currentBranch: "main",
        branches: [{ name: "main" }],
      }),
      getGitCurrentBranch: async () => ({
        success: true,
        currentBranch: "main",
      }),
      getPrInfo: async () => null,
      listPromptHistory: async () => ["run the tests", "explain this file"],
      addPromptHistory: async (prompt: string) => [prompt],
    },
  };
});

describe("ChatComposer sizing", () => {
  it("keeps a conversation composer at a natural two-line minimum", () => {
    renderComposer(true);

    const input = screen.getByRole("textbox");
    expect(input.getAttribute("rows")).toBe("2");
    expect(input.getAttribute("data-composer-mode")).toBe("conversation");
  });

  it("gives a new chat a natural three-line minimum", () => {
    renderComposer(false);

    const input = screen.getByRole("textbox");
    expect(input.getAttribute("rows")).toBe("3");
    expect(input.getAttribute("data-composer-mode")).toBe("new-chat");
  });

  it("keeps controls in the composer and omits an empty PR status", async () => {
    renderComposer(false);
    await screen.findByText("main");

    const composer = document.querySelector('[data-id="local-code-composer"]');
    const permission = screen.getByRole("button", { name: "Permission mode" });
    const worktree = document.querySelector(
      '[data-id="local-code-worktree-selector"]'
    );
    const pr = document.querySelector('[data-id="local-code-pr-status"]');
    const branch = document.querySelector(
      '[data-id="local-code-branch-selector"]'
    );

    // Full-width by design now: the input bar owns the window's bottom edge
    // to edge, iMessage-style, while the transcript stays a centered column.
    expect(composer?.querySelector(".max-w-4xl")).toBeNull();
    expect(composer?.querySelector(".max-w-3xl")).toBeNull();
    expect(composer?.querySelector(".max-w-2xl")).toBeNull();
    expect(permission.closest('[data-id="local-code-composer"]')).toBe(
      composer
    );
    const contextRail = worktree?.closest(
      '[data-slot="composer-context-rail"]'
    );
    // A plain row under the box with the toolbar's insets — not a tab sized
    // to the box, which the compact composer's + beside the box knocks askew.
    expect(contextRail?.className).not.toContain("rounded-b-xl");
    expect(contextRail?.className).not.toContain("w-[calc(100%-2rem)]");
    expect(contextRail?.className).toContain("px-1");
    expect(pr).toBeNull();
    expect(branch).not.toBeNull();
  });

  it("hides send while worktree preparation is pending", () => {
    renderComposer(false, {
      inputValue: "Start in a new worktree",
      canSend: true,
      worktreeMutationPending: true,
    });

    expect(
      document.querySelector('[data-id="local-code-send-btn"]')
    ).toBeNull();
  });

  it("removes the checkout rail when the workspace is not a git repository", async () => {
    const getGitBranches = vi.fn().mockResolvedValue({
      success: false,
      currentBranch: null,
      branches: [],
      error: "Git is not initialized here.",
    });
    window.api.agent.getGitBranches = getGitBranches;
    window.api.agent.getGitCurrentBranch = async () => ({
      success: false,
      currentBranch: null,
    });

    renderComposer(false);

    await waitFor(() => expect(getGitBranches).toHaveBeenCalledOnce());
    expect(
      document.querySelector('[data-slot="composer-context-rail"]')
    ).toBeNull();
  });

  it("opens the attachment menu with its grouped labels and actions", async () => {
    renderComposer(false);

    const trigger = document.querySelector(
      '[data-id="local-code-attachment-btn"]'
    ) as HTMLButtonElement;
    fireEvent.click(trigger);

    expect(await screen.findByText("workspace.attach.menuLabel")).toBeDefined();
    expect(screen.getByText("workspace.attach.files")).toBeDefined();
    expect(screen.getByText("workspace.attach.mentionTip")).toBeDefined();
  });
});

describe("composer pull request status", () => {
  it("opens the queried pull request through the preload bridge", () => {
    render(<PrStatusPill pr={pullRequest} />);

    fireEvent.click(screen.getByRole("button", { name: "Open PR #315" }));

    expect(openExternal).toHaveBeenCalledWith(pullRequest.url);
  });

  it("shows PR context in a hover card with an explicit open action", async () => {
    render(<PrStatusPill pr={pullRequest} branch="renderer-redesign" />);

    const trigger = screen.getByRole("button", { name: "Open PR #315" });
    fireEvent.pointerEnter(trigger);
    fireEvent.mouseEnter(trigger);

    await waitFor(() => {
      expect(screen.getByText("Renderer redesign")).toBeDefined();
    });
    expect(screen.getByText("renderer-redesign")).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", {
        name: "workspace.prStatus.openAction",
      })
    );
    expect(openExternal).toHaveBeenCalledWith(pullRequest.url);
  });
});

/**
 * The two gates in front of an empty composer.
 *
 * Both block typing rather than letting a message be written and fail on send,
 * and the placeholder names whichever one is shut: a folder to work in, and a
 * model to answer with. Clicking anywhere in the box opens the fix, because a
 * disabled textarea that only greys out is a dead end with no next step.
 */
describe("sending while the agent is busy", () => {
  // A message sent mid-turn steers the turn (the host hands it to the model
  // at its next step), so the box must not go dead the moment a turn starts.
  it("keeps Send beside Stop and sends on Enter", () => {
    const onSend = vi.fn(async () => {});
    const onStop = vi.fn();
    renderComposer(true, {
      inputValue: "actually, make it shorter",
      canSend: true,
      isSendLoading: true,
      onSend,
      onStop,
    });

    expect(
      document.querySelector('[data-id="local-code-stop-btn"]')
    ).not.toBeNull();
    expect(
      document.querySelector('[data-id="local-code-send-btn"]')
    ).not.toBeNull();

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("says where the message will land", () => {
    renderComposer(true, { canSend: true, isSendLoading: true });

    expect(screen.getByRole("textbox").getAttribute("placeholder")).toBe(
      "workspace.composerPlaceholderBusy"
    );
  });
});

describe("ChatComposer gates", () => {
  const clickSend = (): void => {
    fireEvent.click(
      document.querySelector('[data-id="local-code-send-btn"]') as HTMLElement
    );
  };

  const gateText = (): string | null =>
    document.querySelector('[data-id="local-code-send-gate"]')?.textContent ??
    null;

  // Typing is never blocked now: the thought is worth keeping even when the
  // setup is not finished.
  it("lets you type with no workspace and no model", () => {
    renderComposer(false, { activeWorkspaceId: null, models: [] });

    const input = screen.getByRole("textbox");
    expect(input.hasAttribute("disabled")).toBe(false);
    expect(input.getAttribute("placeholder")).toBe(
      "workspace.composerPlaceholder"
    );
  });

  // No folder is not a gate any more: the send lands in the app's own
  // session folder ("Auto workspace"), made by the panel on the way out.
  it("sends with no workspace, leaving the auto folder to the panel", () => {
    const onSend = vi.fn(async () => {});
    renderComposer(false, {
      activeWorkspaceId: null,
      inputValue: "hello",
      canSend: true,
      onSend,
    });

    clickSend();
    expect(gateText()).toBeNull();
    expect(onSend).toHaveBeenCalled();
  });

  it("asks for a model once there is a workspace but nothing to run", () => {
    renderComposer(false, { models: [], inputValue: "hello", canSend: true });

    clickSend();
    expect(gateText()).toContain("workspace.sendGate.modelTitle");
  });

  // The message the user typed is the reason for the gate; sending must not
  // consume it while the gate is still shut.
  it("does not send while a gate is shut", () => {
    const onSend = vi.fn(async () => {});
    renderComposer(false, {
      models: [],
      inputValue: "hello",
      canSend: true,
      onSend,
    });

    clickSend();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("takes the composer at its word once both are answered", () => {
    renderComposer(false);

    const input = screen.getByRole("textbox");
    expect(input.hasAttribute("disabled")).toBe(false);
    expect(input.getAttribute("placeholder")).toBe(
      "workspace.composerPlaceholder"
    );
  });

  // Typing stays open while the catalog loads, but send cannot confirm a model
  // it has not seen, so it gates rather than firing a message that would fail.
  // This is what send already did before the gate replaced its toast.
  it("gates on the model while the catalog is still loading", () => {
    renderComposer(false, { models: null, inputValue: "hello", canSend: true });

    expect(screen.getByRole("textbox").hasAttribute("disabled")).toBe(false);
    clickSend();
    expect(gateText()).toContain("workspace.sendGate.modelTitle");
  });
});

/**
 * The up-arrow walks the prompt history — but only where a shell would.
 *
 * The pickers own the arrows while they are open, and a multi-line draft is
 * still something you move a caret around in: paging history from the middle
 * of one would make editing it impossible.
 */
describe("ChatComposer prompt history", () => {
  const arrow = (key: "ArrowUp" | "ArrowDown", caret: number): void => {
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    input.selectionStart = caret;
    input.selectionEnd = caret;
    fireEvent.keyDown(input, { key });
  };

  it("recalls the last prompt from the first line", async () => {
    const onInputValueChange = vi.fn();
    renderComposer(false, { onInputValueChange });

    await waitFor(() =>
      expect(screen.getByRole("textbox")).toBeInstanceOf(HTMLTextAreaElement)
    );
    arrow("ArrowUp", 0);

    await waitFor(() =>
      expect(onInputValueChange).toHaveBeenCalledWith("run the tests")
    );
  });

  it("leaves the caret alone in the middle of a draft", async () => {
    const onInputValueChange = vi.fn();
    renderComposer(false, {
      inputValue: "a draft\nwith two lines",
      onInputValueChange,
    });

    // Caret past the start: this is someone editing, not someone reaching for
    // the last thing they sent.
    arrow("ArrowUp", 5);

    expect(onInputValueChange).not.toHaveBeenCalled();
  });
});

/**
 * One box everywhere: a session runs the same compact composer a bot does.
 * What a session keeps is the two controls a person supervising a run needs —
 * what the agent is allowed to do, and which checkout it runs against. A bot
 * has neither, because nobody is watching it to make either call.
 */
describe("the compact composer in a session", () => {
  it("still offers the permission mode", () => {
    renderComposer(true, { compact: true, canSelectMode: true });

    expect(screen.getByText("Permission mode")).toBeTruthy();
  });

  it("still offers the checkout to run against", async () => {
    // The rail waits on the git read that says there is a repo at all.
    renderComposer(true, { compact: true, canSelectMode: true });

    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="composer-context-rail"]')
      ).toBeTruthy()
    );
  });

  it("offers neither in a bot's chat", async () => {
    renderComposer(true, { compact: true, canSelectMode: false });

    await waitFor(() =>
      expect(screen.queryByText("Permission mode")).toBeNull()
    );
    expect(
      document.querySelector('[data-slot="composer-context-rail"]')
    ).toBeNull();
  });
});

/**
 * The typed text is transparent and a highlight overlay behind it draws the
 * colored tokens, so the two must wrap at exactly the same column. The
 * textarea reserves a strip on its trailing edge for the send button; an
 * overlay that did not wrapped a long line ~2rem later, and past that column
 * the caret dropped to a new line while the visible text stayed on the old
 * one. Any width the two do not share is drift.
 */
describe("the caret and the text it sits on", () => {
  const boxes = (): { textarea: string; overlay: string } => {
    const textarea = document.querySelector("textarea");
    const overlay = document.querySelector(
      '[aria-hidden][class*="whitespace-pre-wrap"]'
    );
    if (textarea == null || overlay == null)
      throw new Error("composer did not render its textarea and overlay");

    return { textarea: textarea.className, overlay: overlay.className };
  };

  const padding = (className: string): string[] =>
    className.split(/\s+/).filter((name) => /^(p|ps|pe|px)-/.test(name));

  it("reserves the send button's strip on both, not just the input", () => {
    renderComposer(true, { inputValue: "hello" });
    const { textarea, overlay } = boxes();

    expect(padding(textarea)).toContain("pe-12");
    expect(padding(overlay)).toContain("pe-12");
  });

  it("starts both at the same leading edge", () => {
    renderComposer(true, { inputValue: "hello" });
    const { textarea, overlay } = boxes();

    expect(padding(textarea)).toContain("ps-3.5");
    expect(padding(overlay)).toContain("ps-3.5");
  });

  it("gives neither a symmetric px- that would undo the reservation", () => {
    // `px-3.5` on the overlay is exactly the bug: it silently overrides the
    // trailing strip and puts the wrap column back where it was.
    renderComposer(true, { inputValue: "hello", compact: true });
    const { overlay } = boxes();

    expect(padding(overlay).some((name) => name.startsWith("px-"))).toBe(false);
  });
});

/**
 * A pill is the right shape for one line of text and the wrong one for a
 * stack. `rounded-full` on a box this wide is a radius of half its height, so
 * a permission card's rows ran straight out through the curve — the command
 * box and the Deny row ended up drawn outside their own container.
 */
describe("the compact composer's shape", () => {
  const boxClass = (): string => {
    const box = document.querySelector('[data-slot="composer-box"]');
    if (box == null) throw new Error("composer did not render its box");
    return box.className;
  };

  const bashPermission = {
    permissionId: "perm-1",
    toolName: "Bash",
    toolInput: { command: "date" },
    workspaceId: "workspace-1",
    sessionId: "session-1",
  };

  it("is a pill while it is just a message box", () => {
    renderComposer(true, { compact: true });

    expect(boxClass()).toContain("rounded-full");
  });

  it("squares off while a permission card is in it", () => {
    renderComposer(true, {
      compact: true,
      agentStatus: AgentStatus.WaitingForToolPermission,
      pendingPermission: bashPermission,
    });

    expect(boxClass()).toContain("rounded-2xl");
    expect(boxClass()).not.toContain("rounded-full");
  });

  it("stays square when it is not compact either way", () => {
    renderComposer(true, {
      compact: false,
      agentStatus: AgentStatus.WaitingForToolPermission,
      pendingPermission: bashPermission,
    });

    expect(boxClass()).not.toContain("rounded-full");
  });
});

/**
 * A pill is right for one line and wrong for several: on a box this wide,
 * `rounded-full` is a radius of half its height, so a wrapped message runs
 * out through the curve.
 */
describe("the compact composer as the message grows", () => {
  const boxClass = (): string => {
    const box = document.querySelector('[data-slot="composer-box"]');
    if (box == null) throw new Error("composer did not render its box");
    return box.className;
  };

  /**
   * jsdom lays nothing out, so the grown height is stated rather than
   * measured. On the prototype because the box sizes itself as it mounts.
   */
  const withScrollHeight = (px: number): (() => void) => {
    const original = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "scrollHeight"
    );
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => px,
    });
    return () => {
      if (original == null)
        delete (HTMLTextAreaElement.prototype as { scrollHeight?: unknown })
          .scrollHeight;
      else
        Object.defineProperty(
          HTMLTextAreaElement.prototype,
          "scrollHeight",
          original
        );
    };
  };

  it("is a pill on one line", () => {
    const restore = withScrollHeight(37);
    renderComposer(true, { compact: true, inputValue: "hi" });
    restore();

    expect(boxClass()).toContain("rounded-full");
  });

  it("squares off once the text wraps", () => {
    const restore = withScrollHeight(120);
    renderComposer(true, {
      compact: true,
      inputValue: "a very long message that wraps onto several lines",
    });
    restore();

    expect(boxClass()).toContain("rounded-2xl");
    expect(boxClass()).not.toContain("rounded-full");
  });
});

describe("dictation", () => {
  it("puts the spoken words after the typed ones, in both shapes", () => {
    for (const compact of [false, true]) {
      const onInputValueChange = vi.fn();
      renderComposer(true, {
        compact,
        inputValue: "fix the",
        onInputValueChange,
      });

      dictation.onText?.("login bug");

      expect(onInputValueChange).toHaveBeenCalledWith("fix the login bug");
      expect(
        document.querySelector('[data-id="local-code-dictation-btn"]')
      ).toBeTruthy();
      cleanup();
    }
  });
});
