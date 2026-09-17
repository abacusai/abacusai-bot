import {
  Check,
  ChevronDown,
  Minus,
  Plus,
  SquareTerminal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, type JSX } from "react";
import { useTranslation } from "react-i18next";

import type {
  ConversationKey,
  ConversationRef,
} from "#shared/conversation-scope";
import { TERMINAL_SHELLS, type TerminalShellId } from "#shared/terminal-shells";

import {
  useSetTerminalShell,
  useTerminalShellState,
} from "../../hooks/use-terminal-shells";
import {
  terminalRuntimeActions,
  useTerminalRuntimeScope,
} from "../../stores/terminal-runtime-store";
import {
  acquireTerminalView,
  closeTerminalView,
} from "../../terminals/terminal-views";
import { Button } from "../ui";
import { ButtonGroup } from "../ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

type TerminalPanelProps = {
  conversation: ConversationRef | null;
  conversationKey: ConversationKey | null;
  generation: number | null;
  visible?: boolean;
  onClose?: () => void;
};

type TerminalInstanceProps = Omit<TerminalPanelProps, "onClose" | "visible"> & {
  terminalId: string;
  active: boolean;
  /** Absent asks main for the stored preference; a picked shell names itself. */
  shell?: TerminalShellId;
  onExited: (terminalId: string) => void;
};

const TerminalInstance = ({
  conversation,
  conversationKey,
  terminalId,
  active,
  shell,
  onExited,
}: TerminalInstanceProps): JSX.Element => {
  const hostRef = useRef<HTMLDivElement>(null);
  // The workspace view builds a fresh conversation object on every render, so
  // it is read through a ref rather than depended on: the key says the same
  // thing and is a string.
  const conversationRef = useRef<ConversationRef | null>(conversation);
  const shellRef = useRef<TerminalShellId | undefined>(shell);

  useEffect(() => {
    conversationRef.current = conversation;
    shellRef.current = shell;
  }, [conversation, shell]);

  // Mount the tab's terminal. It was built the first time this ran and it
  // outlives every render after that, PTY and scrollback included.
  useEffect(() => {
    const host = hostRef.current;
    const conversationValue = conversationRef.current;
    if (host == null || conversationKey == null || conversationValue == null) {
      return;
    }

    const view = acquireTerminalView({
      conversationKey,
      conversation: conversationValue,
      terminalId,
      shell: shellRef.current,
    });
    host.replaceChildren(view.element);
    const stopListening = view.onExit(() => onExited(terminalId));

    return () => {
      stopListening();
      view.setVisible(false);
      view.element.remove();
    };
  }, [conversationKey, onExited, terminalId]);

  useEffect(() => {
    if (conversationKey == null) return;
    const view = acquireTerminalView({
      conversationKey,
      conversation: conversationRef.current!,
      terminalId,
      shell: shellRef.current,
    });
    view.setVisible(active);
  }, [active, conversationKey, terminalId]);

  return (
    <div
      data-terminal-instance={terminalId}
      data-terminal-id={terminalId}
      ref={hostRef}
      className="relative h-full min-h-0 w-full overflow-hidden bg-[#1e1e1e]"
    />
  );
};

export const TerminalPanel = ({
  conversation,
  conversationKey,
  generation,
  visible = true,
  onClose,
}: TerminalPanelProps): JSX.Element => {
  const { t } = useTranslation();
  const runtime = useTerminalRuntimeScope(conversationKey);
  const shellState = useTerminalShellState();
  const rememberShell = useSetTerminalShell();
  const activeTab =
    runtime.tabs.find(({ id }) => id === runtime.activeTabId) ??
    runtime.tabs[0] ??
    null;

  useEffect(() => {
    if (
      conversationKey != null &&
      generation != null &&
      activeTab != null &&
      activeTab.generation == null
    ) {
      terminalRuntimeActions.setGeneration(
        conversationKey,
        generation,
        activeTab.id
      );
    }
  }, [activeTab, conversationKey, generation]);

  const shellLabel = useCallback(
    (id: TerminalShellId): string => {
      const shell = TERMINAL_SHELLS.find((entry) => entry.id === id);

      return t(`terminalShells.${shell?.labelKey ?? id}.label`, {
        defaultValue: id,
      });
    },
    [t]
  );

  /**
   * No argument is the `+` button: main opens whatever was stored, which is
   * also what the panel's own automatic terminal gets. An id is a pick from
   * the menu, and a pick is remembered.
   */
  const openTab = useCallback(
    (shell?: TerminalShellId): void => {
      if (conversationKey == null) return;
      if (shell == null) {
        terminalRuntimeActions.addTab(conversationKey);
        return;
      }
      rememberShell(shell);
      terminalRuntimeActions.addTab(conversationKey, {
        shell,
        label: shellLabel(shell),
      });
    },
    [conversationKey, rememberShell, shellLabel]
  );

  const closeTab = useCallback(
    (terminalId: string): void => {
      if (conversationKey == null) return;
      // The view owns the PTY, so closing it is what kills the shell.
      closeTerminalView(conversationKey, terminalId);
      terminalRuntimeActions.closeTab(conversationKey, terminalId);
      if (runtime.tabs.length === 1) onClose?.();
    },
    [conversationKey, onClose, runtime.tabs.length]
  );

  // Hiding the tab that is leaving is the instance's own business: it is told
  // it is off screen and tells main.
  const selectTab = (terminalId: string): void => {
    if (conversationKey == null || runtime.activeTabId === terminalId) return;
    terminalRuntimeActions.selectTab(conversationKey, terminalId);
  };

  return (
    <div
      data-terminal-owner="center"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[#1e1e1e]"
    >
      <div
        data-slot="terminal-tabs"
        className="border-border/70 flex h-7 shrink-0 items-center gap-1 border-b bg-[#1e1e1e] px-1"
      >
        <div
          role="tablist"
          aria-label={t("workspace.terminal.tabs", {
            defaultValue: "Terminal tabs",
          })}
          className="flex min-w-0 flex-1 [scrollbar-width:none] items-center gap-0.5 overflow-x-auto [&::-webkit-scrollbar]:h-0"
        >
          {runtime.tabs.map((tab) => {
            const active = tab.id === activeTab?.id;
            return (
              <div
                key={tab.id}
                className={`group/tab relative flex h-6 max-w-36 shrink-0 items-center rounded-md ${
                  active
                    ? "bg-white/8 text-white"
                    : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
                }`}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  role="tab"
                  aria-selected={active}
                  className="h-6 min-w-0 flex-1 justify-start gap-1.5 ps-2 pe-6 text-xs focus-visible:ring-1 focus-visible:ring-violet-500"
                  onClick={() => selectTab(tab.id)}
                >
                  <SquareTerminal className="size-3.5 shrink-0" />
                  <span className="truncate">{tab.label}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="absolute end-1 size-4 rounded-sm text-zinc-400 opacity-70 group-hover/tab:opacity-100 hover:text-white"
                  aria-label={t("workspace.terminal.closeTab", {
                    defaultValue: `Close ${tab.label}`,
                  })}
                  onClick={() => closeTab(tab.id)}
                >
                  <X />
                </Button>
              </div>
            );
          })}
        </div>

        {/* One control, not two: the `+` opens a terminal in a click and the
            chevron beside it is the only thing that asks which shell. */}
        <ButtonGroup className="shrink-0 gap-0">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-6 text-zinc-400 hover:text-white"
                  data-id="terminal-new-tab"
                  aria-label={t("workspace.terminal.newTab", {
                    defaultValue: "New terminal",
                  })}
                  onClick={() => openTab()}
                />
              }
            >
              <Plus />
            </TooltipTrigger>
            <TooltipContent side="top">
              {t("workspace.terminal.newTab", {
                defaultValue: "New terminal",
              })}
            </TooltipContent>
          </Tooltip>

          {shellState != null && shellState.statuses.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-6 w-4 text-zinc-400 hover:text-white"
                    data-id="terminal-shell-picker"
                    aria-label={t("workspace.terminal.pickShell", {
                      defaultValue: "Open a different shell",
                    })}
                  />
                }
              >
                <ChevronDown className="size-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="end" className="min-w-44">
                {shellState.statuses.map((status) => (
                  <DropdownMenuItem
                    key={status.id}
                    disabled={!status.available}
                    data-id={`terminal-shell-${status.id}`}
                    onClick={() => openTab(status.id)}
                  >
                    {status.id === shellState.effective ? (
                      <Check />
                    ) : (
                      <SquareTerminal />
                    )}
                    {shellLabel(status.id)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </ButtonGroup>

        {onClose != null && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  data-id="terminal-panel-close"
                  onClick={onClose}
                  className="size-6 shrink-0 text-zinc-400 hover:text-white"
                  aria-label={t("workspace.terminal.hide")}
                />
              }
            >
              <Minus />
            </TooltipTrigger>
            <TooltipContent side="top">
              {t("workspace.terminal.hide")}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className="min-h-0 flex-1 bg-[#1e1e1e]">
        {runtime.tabs.map((tab) => {
          const active = tab.id === activeTab?.id;
          return (
            <div key={tab.id} className={active ? "h-full" : "hidden"}>
              <TerminalInstance
                terminalId={tab.id}
                conversation={conversation}
                conversationKey={conversationKey}
                generation={tab.generation}
                shell={tab.shell}
                active={visible && active}
                onExited={closeTab}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};
