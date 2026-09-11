import {
  FitAddon,
  init as initGhostty,
  Terminal as GhosttyTerminal,
  UrlRegexProvider,
  OSC8LinkProvider,
  type ILinkProvider,
  type ILink,
} from "ghostty-web";
import { Minus, Plus, SquareTerminal, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";

import type {
  ConversationKey,
  ConversationRef,
} from "#shared/conversation-scope";

import {
  terminalRuntimeActions,
  useTerminalRuntimeScope,
} from "../../stores/terminal-runtime-store";
import { openUrlInPreview } from "../../utils/preview-utils";
import { Button } from "../ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

const createPreviewLinkProvider = (inner: ILinkProvider): ILinkProvider => ({
  provideLinks(
    y: number,
    callback: (links: ILink[] | undefined) => void
  ): void {
    inner.provideLinks(y, (links) => {
      if (links == null) {
        callback(undefined);
        return;
      }
      callback(
        links.map((link) => ({
          ...link,
          activate: () => {
            openUrlInPreview(link.text);
          },
        }))
      );
    });
  },
  dispose(): void {
    inner.dispose?.();
  },
});

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
  onExited: (terminalId: string) => void;
};

let ghosttyInitialized = false;
let ghosttyInitPromise: Promise<void> | null = null;

const ensureGhostty = async (): Promise<void> => {
  if (ghosttyInitialized) {
    return;
  }
  if (ghosttyInitPromise != null) {
    return ghosttyInitPromise;
  }
  ghosttyInitPromise = initGhostty()
    .then(() => {
      ghosttyInitialized = true;
    })
    .catch((error) => {
      ghosttyInitPromise = null;
      throw error;
    });
  return ghosttyInitPromise;
};

const useSizeObserver = (
  nodeRef: RefObject<HTMLElement | null>,
  onResize: () => void
): void => {
  useEffect(() => {
    const node = nodeRef.current;
    if (node == null) {
      return;
    }
    const observer = new ResizeObserver(() => {
      onResize();
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [nodeRef, onResize]);
};

const TerminalInstance = ({
  conversation,
  conversationKey,
  generation,
  terminalId,
  active,
  onExited,
}: TerminalInstanceProps): JSX.Element => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<GhosttyTerminal>(null);
  const fitAddonRef = useRef<FitAddon>(null);
  const pendingResizeRef = useRef<number>(null);
  const conversationKeyRef = useRef<ConversationKey | null>(conversationKey);
  const generationRef = useRef<number | null>(generation);

  // Bumped whenever the PTY dies, so the next reopen rebuilds the
  // GhosttyTerminal instead of typing into a dead buffer.
  const [ptyGeneration, setPtyGeneration] = useState(0);
  const [isTerminalReady, setIsTerminalReady] = useState(false);

  useEffect(() => {
    conversationKeyRef.current = conversationKey;
    generationRef.current = generation;
  }, [conversationKey, generation]);

  useEffect(() => {
    let disposed = false;

    const initialize = async (): Promise<void> => {
      const hostNode = containerRef.current;
      if (hostNode == null || terminalRef.current != null) {
        return;
      }
      try {
        await ensureGhostty();
      } catch {
        if (!disposed) {
          setIsTerminalReady(false);
        }
        return;
      }
      if (disposed || !hostNode.isConnected) {
        return;
      }

      const term = new GhosttyTerminal({
        fontSize: 13,
        fontFamily: "'JetBrains Mono', monospace",
        cursorBlink: true,
        cursorStyle: "block",
        scrollback: 3000,
        convertEol: true,
        theme: {
          background: "#1e1e1e",
          foreground: "#d4d4d4",
          cursor: "#d4d4d4",
          cursorAccent: "#1e1e1e",
          selectionBackground: "rgba(124, 58, 237, 0.4)",
          selectionForeground: "#d4d4d4",
          black: "#000000",
          red: "#ff6b6b",
          green: "#51cf66",
          yellow: "#ffd93d",
          blue: "#6c9aff",
          magenta: "#c77dff",
          cyan: "#25d9f5",
          white: "#d4d4d4",
          brightBlack: "#666666",
          brightRed: "#ff8787",
          brightGreen: "#69f0ae",
          brightYellow: "#ffe066",
          brightBlue: "#8fb3ff",
          brightMagenta: "#da99ff",
          brightCyan: "#5ce0e8",
          brightWhite: "#ffffff",
        },
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      try {
        term.open(hostNode);
      } catch {
        term.dispose();
        if (!disposed) {
          setIsTerminalReady(false);
        }
        return;
      }

      term.registerLinkProvider(
        createPreviewLinkProvider(new UrlRegexProvider(term))
      );
      term.registerLinkProvider(
        createPreviewLinkProvider(new OSC8LinkProvider(term))
      );

      term.onData((data) => {
        const currentConversationKey = conversationKeyRef.current;
        const currentGeneration = generationRef.current;
        if (currentConversationKey == null || currentGeneration == null) {
          return;
        }
        void window.api.agent.writeTerminalInput({
          terminalId,
          conversationKey: currentConversationKey,
          generation: currentGeneration,
          data,
        });
      });

      terminalRef.current = term;
      fitAddonRef.current = fitAddon;
      setIsTerminalReady(true);
    };

    void initialize();

    return () => {
      disposed = true;
      if (pendingResizeRef.current != null) {
        window.clearTimeout(pendingResizeRef.current);
        pendingResizeRef.current = null;
      }
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      setIsTerminalReady(false);
    };
    // ptyGeneration is deliberately a dep: a dead PTY needs a fresh terminal.
  }, [conversationKey, ptyGeneration, terminalId]);

  const syncSize = (): void => {
    if (conversationKey == null || generation == null) {
      return;
    }
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (terminal == null || fitAddon == null) {
      return;
    }

    const proposed = fitAddon.proposeDimensions();
    if (proposed == null) {
      return;
    }

    const { cols: nextCols, rows: nextRows } = proposed;
    if (nextCols === terminal.cols && nextRows === terminal.rows) {
      return;
    }

    terminal.resize(nextCols, nextRows);
    void window.api.agent.resizeTerminalSession({
      terminalId,
      conversationKey,
      generation,
      cols: nextCols,
      rows: nextRows,
    });
  };

  useSizeObserver(containerRef, () => {
    if (pendingResizeRef.current != null) {
      window.clearTimeout(pendingResizeRef.current);
    }
    pendingResizeRef.current = window.setTimeout(() => {
      pendingResizeRef.current = null;
      syncSize();
    }, 40);
  });

  // Spawn / attach the PTY whenever the panel is visible; after a PTY death
  // main has no surviving session, so this spawns a new one.
  useEffect(() => {
    if (
      !active ||
      conversation == null ||
      conversationKey == null ||
      !isTerminalReady
    ) {
      return;
    }
    let cancelled = false;
    const term = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (term == null || fitAddon == null) {
      return;
    }

    const start = async (): Promise<void> => {
      fitAddon.fit();
      const proposed = fitAddon.proposeDimensions();
      if (proposed == null) {
        return;
      }
      const { cols, rows } = proposed;
      term.resize(cols, rows);
      const result = await window.api.agent.startTerminalSession({
        terminalId,
        conversationKey,
        conversation,
        generation: generationRef.current,
        cols,
        rows,
      });
      if (!result.success) {
        return;
      }
      if (cancelled || terminalRef.current !== term) {
        return;
      }
      generationRef.current = result.state.generation;
      terminalRuntimeActions.setGeneration(
        conversationKey,
        result.state.generation,
        terminalId
      );
      term.clear();
      if (result.initialOutput.length > 0) {
        term.write(result.initialOutput);
      }
    };

    void start();
    return () => {
      cancelled = true;
    };
  }, [
    active,
    conversation,
    conversationKey,
    isTerminalReady,
    ptyGeneration,
    terminalId,
  ]);

  useEffect(() => {
    if (active || conversationKey == null) return;
    const activeGeneration = generationRef.current;
    if (activeGeneration == null) return;
    void window.api.agent.hideTerminalSession({
      terminalId,
      conversationKey,
      generation: activeGeneration,
    });
  }, [active, conversationKey, terminalId]);

  useEffect(() => {
    if (conversationKey == null) return;
    return () => {
      const activeGeneration = generationRef.current;
      if (activeGeneration == null) return;
      void window.api.agent.hideTerminalSession({
        terminalId,
        conversationKey,
        generation: activeGeneration,
      });
    };
  }, [conversationKey, terminalId]);

  // PTY → terminal: write output, auto-collapse on exit, bump ptyGeneration.
  useEffect(() => {
    if (conversationKey == null) {
      return;
    }

    const unsubscribe = window.api.agent.onEvent((event) => {
      const term = terminalRef.current;
      if (
        event.type === "terminal-output" &&
        event.terminalId === terminalId &&
        event.conversationKey === conversationKey &&
        event.generation === generationRef.current
      ) {
        term?.write(event.data);
        return;
      }
      if (
        event.type === "terminal-exited" &&
        event.terminalId === terminalId &&
        event.conversationKey === conversationKey &&
        event.generation === generationRef.current
      ) {
        terminalRuntimeActions.setGeneration(conversationKey, null, terminalId);
        setPtyGeneration((g) => g + 1);
        onExited(terminalId);
      }
    });

    return unsubscribe;
  }, [conversationKey, onExited, terminalId]);

  return (
    <div
      data-terminal-instance={terminalId}
      data-terminal-id={terminalId}
      className="relative h-full min-h-0 w-full overflow-hidden bg-[#1e1e1e]"
    >
      <div
        ref={containerRef}
        data-slot="terminal-host"
        className="h-full w-full overflow-hidden bg-[#1e1e1e]"
      />
    </div>
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

  const closeTab = useCallback(
    (terminalId: string): void => {
      if (conversationKey == null) return;
      const tab = runtime.tabs.find(({ id }) => id === terminalId);
      if (tab?.generation != null) {
        void window.api.agent.hideTerminalSession({
          terminalId,
          conversationKey,
          generation: tab.generation,
          close: true,
        });
      }
      terminalRuntimeActions.closeTab(conversationKey, terminalId);
      if (runtime.tabs.length === 1) onClose?.();
    },
    [conversationKey, onClose, runtime.tabs]
  );

  const selectTab = (terminalId: string): void => {
    if (conversationKey == null || runtime.activeTabId === terminalId) return;
    if (activeTab?.generation != null) {
      void window.api.agent.hideTerminalSession({
        terminalId: activeTab.id,
        conversationKey,
        generation: activeTab.generation,
      });
    }
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

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-6 shrink-0 text-zinc-400 hover:text-white"
                aria-label={t("workspace.terminal.newTab", {
                  defaultValue: "New terminal",
                })}
                onClick={() => {
                  if (conversationKey != null)
                    terminalRuntimeActions.addTab(conversationKey);
                }}
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
