import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import {
  conversationKey,
  conversationRefFromKey,
  sessionConversationRef,
  type ConversationRef,
} from "@abacus-ai/contract/conversation-scope";
import { installMouseReporting } from "@abacus-ai/contract/terminal/mouse-compat";
import { UrlRegexProvider, OSC8LinkProvider } from "ghostty-web";
import { ClipboardPaste, Copy, Eraser, RotateCcw } from "lucide-react";
import { useContext, useEffect, useEffectEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  repaint,
  writeTerminalData,
} from "#renderer/components/terminal/ghostty";
import {
  terminalKeyHandler,
  type TerminalAction,
} from "#renderer/components/terminal/keys";
import { followNotices } from "#renderer/data/queries/notices";
import { isRpcError } from "#renderer/data/query-client";
import { TerminalActionBindingsContext } from "#renderer/lib/keyboard/action-bindings";
import { uiPlatform } from "#renderer/lib/platform";
import { Button } from "#renderer/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "#renderer/ui/context-menu";

import { useSessionsTransport } from "../data/queries";
import { retainTerminalStart } from "../dock/panel-tabs-store";
import { pumpOutput, type OutputView } from "./output-pump";
import {
  clearTerminal,
  getTerminalView,
  type TerminalView,
} from "./terminal-registry";
/** Why a hosted computer refused the terminal on this plan, if it did. */
const planRefusal = (error: unknown): string | null =>
  isRpcError(error) && error.code === "PRECONDITION_FAILED"
    ? (error.data?.reason ?? null)
    : null;
const outputView = (
  view: TerminalView,
  write: OutputView["write"]
): OutputView => ({
  get offset() {
    return view.offset;
  },
  set offset(n) {
    view.offset = n;
  },
  write,
  reset: () => {
    if (view.offset !== undefined) view.term.reset();
  },
});

export const TerminalTab = ({
  row,
  id,
  visible,
  onClose,
  dispatch,
  onUrl,
  shell,
  conversation: scope,
}: {
  row: Pick<SessionRow, "workspaceId" | "id">;
  /** A new chat's draft; otherwise the chat's own. */
  conversation?: ConversationRef;
  id: string;
  visible: boolean;
  onClose: () => void;
  dispatch: (id: TerminalAction) => void;
  onUrl: (url: string) => void;
  shell?: import("@abacus-ai/contract/terminal-shells").TerminalShellId;
}) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const container = useRef<HTMLDivElement>(null);
  const key = conversationKey(
    scope ?? sessionConversationRef(row.workspaceId, row.id)
  );
  const [error, setError] = useState<string | null>(null);
  // An exited shell keeps its tab and output; Restart starts a fresh one there.
  const [exited, setExited] = useState(false);
  const [run, setRun] = useState(0);
  const focused = useRef(false);
  const bindings = useContext(TerminalActionBindingsContext);
  const handleKey = useEffectEvent(
    (
      event: KeyboardEvent,
      platform: "mac" | "windows" | "linux",
      term: Parameters<typeof terminalKeyHandler>[2]
    ) => terminalKeyHandler(platform, dispatch, term, bindings)(event)
  );
  const openUrl = useEffectEvent(onUrl);
  const close = useEffectEvent(onClose);
  useEffect(() => {
    const abort = new AbortController();
    const finishStart = retainTerminalStart(key, id);
    let starting = false;
    const disposers: (() => void)[] = [];
    const cleanup = () => {
      for (const dispose of disposers.splice(0).reverse()) dispose();
    };
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    void getTerminalView(`${key}:${id}`)
      .then(async (view) => {
        if (abort.signal.aborted) return;
        const containerElement = container.current;
        containerElement?.append(view.element);
        disposers.push(() => {
          if (view.element.parentElement === containerElement)
            view.element.remove();
        });
        const initialSize = view.fit.proposeDimensions();
        if (initialSize) view.term.resize(initialSize.cols, initialSize.rows);
        starting = true;
        const start = await transport.client.terminal.start({
          terminalId: id,
          conversationKey: key,
          conversation: conversationRefFromKey(key)!,
          generation: view.generation,
          ...(shell ? { shell } : {}),
          cols: view.term.cols || 80,
          rows: view.term.rows || 24,
        });
        if (!start.success || !start.state)
          throw new Error(start.error ?? "Terminal failed");
        view.generation = start.state.generation;
        if (abort.signal.aborted) {
          cleanup();
          return;
        }
        const input = view.term.onData((data) => {
          void transport.client.terminal
            .write({
              terminalId: id,
              conversationKey: key,
              generation: view.generation!,
              data,
            })
            .catch(() => {});
        });
        disposers.push(() => input.dispose());
        const platform = uiPlatform(
          document.documentElement.dataset.platform ?? "linux"
        );
        view.term.attachCustomKeyEventHandler((event) =>
          handleKey(event, platform, view.term)
        );
        const links = [
          new UrlRegexProvider(view.term),
          new OSC8LinkProvider(view.term),
        ];
        for (const provider of links) {
          disposers.push(() => provider.dispose());
          view.term.registerLinkProvider({
            provideLinks(y, callback) {
              provider.provideLinks(y, (found) =>
                callback(
                  found?.map((link) => ({
                    ...link,
                    activate: () => openUrl(link.text),
                  }))
                )
              );
            },
          });
        }
        const removeMouse = installMouseReporting(view.term, view.element);
        disposers.push(removeMouse);
        // Text the platform inserts without a key or a composition (the
        // Windows emoji panel, macOS press-and-hold accents) arrives as
        // beforeinput, which the renderer cancels and drops: send it on.
        const inserted = (event: InputEvent) => {
          if (
            event.inputType === "insertText" &&
            !event.isComposing &&
            event.data
          )
            view.term.input(event.data, true);
        };
        view.element.addEventListener("beforeinput", inserted, true);
        disposers.push(() =>
          view.element.removeEventListener("beforeinput", inserted, true)
        );
        let outputAbort: AbortController | undefined;
        const connectOutput = () => {
          outputAbort?.abort();
          outputAbort = new AbortController();
          void pumpOutput(
            outputView(view, async (data) => {
              view.received += data.length;
              await writeTerminalData(view.term, data, outputAbort!.signal);
            }),
            (offset, signal) =>
              transport.client.terminal.output(
                {
                  conversationKey: key,
                  terminalId: id,
                  generation: view.generation!,
                  ...(offset !== undefined ? { fromOffset: offset } : {}),
                },
                { signal }
              ),
            outputAbort.signal,
            (chunk) => {
              if (chunk.type === "retired") {
                if (chunk.reason === "closed") close();
                return;
              }
              view.term.write(
                `\r\n${
                  // Stopped from outside (kill -9): a signal, not an exit code.
                  chunk.signal
                    ? t("sessions.terminal.signalled", { signal: chunk.signal })
                    : t("sessions.terminal.exited", {
                        code: chunk.exitCode ?? "",
                      })
                }\r\n`
              );
              setExited(true);
              exitTimer = setTimeout(() => {
                if (!focused.current) close();
              }, 2000);
            },
            (e) => setError(String(e))
          );
        };
        disposers.push(() => {
          outputAbort?.abort();
          if (view.reconnect === connectOutput) view.reconnect = undefined;
        });
        view.reconnect = connectOutput;
        connectOutput();
        void followNotices(
          transport,
          ({ signal }) =>
            transport.client.terminal.events(
              { conversationKey: key },
              { signal }
            ),
          (event) => {
            const state =
              event.type === "snapshot"
                ? event.states.find((s) => s.terminalId === id)
                : event.state.terminalId === id
                  ? event.state
                  : undefined;
            if (state && state.generation !== view.generation) {
              view.generation = state.generation;
              connectOutput();
            }
          },
          abort.signal
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        let paintFrame = 0;
        const fit = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            if (!container.current?.getBoundingClientRect().width) return;
            const size = view.fit.proposeDimensions();
            if (size) {
              view.term.resize(size.cols, size.rows);
              void transport.client.terminal.resize({
                terminalId: id,
                conversationKey: key,
                generation: view.generation!,
                ...size,
              });
            }
            cancelAnimationFrame(paintFrame);
            paintFrame = requestAnimationFrame(() => repaint(view.term));
          }, 40);
        };
        const observer = new ResizeObserver(fit);
        // A code-font change (Appearance) changes the cell size.
        view.refit = fit;
        disposers.push(() => {
          observer.disconnect();
          if (timer) clearTimeout(timer);
          cancelAnimationFrame(paintFrame);
          if (view.refit === fit) view.refit = undefined;
        });
        if (container.current) observer.observe(container.current);
        fit();
        view.term.focus();
      })
      .catch((e) => {
        cleanup();
        if (abort.signal.aborted) return;
        const reason = planRefusal(e);
        const message = e instanceof Error ? e.message : String(e);
        // The chat's folder is gone: say which, and offer Restart for when
        // it is back.
        const missing = message.startsWith("folder-missing:")
          ? message.slice("folder-missing:".length)
          : null;
        const denied = message.startsWith("folder-denied:")
          ? message.slice("folder-denied:".length)
          : null;
        if (missing != null || denied != null) setExited(true);
        setError(
          reason === "plan-required"
            ? t("sessions.terminal.planRequired")
            : reason === "plan-unreadable"
              ? t("sessions.terminal.planUnreadable")
              : missing != null
                ? t("sessions.terminal.folderMissing", { path: missing })
                : denied != null
                  ? t("sessions.terminal.folderDenied", { path: denied })
                  : String(e)
        );
      })
      .finally(finishStart);
    return () => {
      abort.abort();
      if (!starting) finishStart();
      cleanup();
      if (exitTimer) clearTimeout(exitTimer);
    };
  }, [transport, key, id, t, shell, run]);
  const [selection, setSelection] = useState(false);
  /** Runs on this tab's terminal, then gives it the keyboard back. */
  const withTerm = (fn: (term: TerminalView["term"]) => unknown) =>
    void getTerminalView(`${key}:${id}`)
      .then(async (view) => {
        await fn(view.term);
        view.term.focus();
      })
      .catch(() => {});
  const restart = () => {
    setError(null);
    void getTerminalView(`${key}:${id}`).then((view) => {
      // A new generation, read from its start, under the old output.
      view.generation = null;
      view.offset = undefined;
      view.term.write("\r\n");
      setExited(false);
      setRun((n) => n + 1);
    });
  };
  useEffect(() => {
    let live = true;
    void getTerminalView(`${key}:${id}`)
      .then((view) => {
        if (!live) return;
        if (visible) {
          view.refit?.();
          // Shown by the keyboard (next tab, a closed neighbour): the
          // terminal that was typing goes hidden with the focus, so this one
          // takes it. Focus anywhere else (the chat box, a button) stays.
          const focused = document.activeElement;
          if (
            focused == null ||
            focused === document.body ||
            (focused.closest('[data-hotkeys="terminal"]') != null &&
              !container.current?.contains(focused))
          )
            view.term.focus();
        } else if (view.generation != null)
          void transport.client.terminal.hide({
            conversationKey: key,
            terminalId: id,
            generation: view.generation,
          });
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [visible, key, id, transport]);
  return (
    <div
      className="flex size-full flex-col"
      data-hotkeys="terminal"
      role="region"
      aria-label={t("sessions.terminal.title")}
      onFocusCapture={() => {
        focused.current = true;
      }}
      onBlurCapture={() => {
        focused.current = false;
      }}
    >
      {error ? (
        <p role="alert" className="text-muted-foreground px-3 pt-3 text-sm">
          {error}
        </p>
      ) : null}
      {exited ? (
        <div className="flex shrink-0 justify-end border-b px-2 py-1">
          <Button size="sm" variant="secondary" onClick={restart}>
            <RotateCcw />
            {t("sessions.terminal.restart")}
          </Button>
        </div>
      ) : null}
      <ContextMenu
        onOpenChange={(open) => {
          if (open)
            void getTerminalView(`${key}:${id}`).then((view) =>
              setSelection(view.term.hasSelection())
            );
        }}
      >
        <ContextMenuTrigger
          render={<div ref={container} className="min-h-0 flex-1 p-2" />}
        />
        <ContextMenuContent className="w-44">
          <ContextMenuItem
            disabled={!selection}
            onClick={() =>
              withTerm((term) =>
                navigator.clipboard.writeText(term.getSelection())
              )
            }
          >
            <Copy />
            {t("sessions.terminal.copy")}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() =>
              withTerm(async (term) =>
                term.paste(await navigator.clipboard.readText())
              )
            }
          >
            <ClipboardPaste />
            {t("sessions.terminal.paste")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => withTerm(clearTerminal)}>
            <Eraser />
            {t("sessions.terminal.clear")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
};
