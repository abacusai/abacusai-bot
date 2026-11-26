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
  alignToConpty,
  conptyCursorRow,
  rewrapCursorLine,
  type ScreenRow,
} from "#renderer/components/terminal/conpty";
import {
  repaint,
  resetTerminal,
  writeTerminalData,
} from "#renderer/components/terminal/ghostty";
import {
  terminalKeyHandler,
  type TerminalAction,
} from "#renderer/components/terminal/keys";
import { followNotices } from "#renderer/data/queries/notices";
import { isRpcError } from "#renderer/data/query-client";
import { failureText } from "#renderer/lib/error-text";
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
import { afterMenusClose } from "../dock/after-menus-close";
import {
  markTerminalExited,
  rememberTerminalShell,
  retainTerminalStart,
  terminalExited,
} from "../dock/panel-tabs-store";
import { pumpOutput, type OutputView } from "./output-pump";
import {
  clearTerminal,
  getTerminalView,
  peekTerminalView,
  type TerminalView,
} from "./terminal-registry";
/** Why a hosted computer refused the terminal on this plan, if it did. */
const planRefusal = (error: unknown): string | null =>
  isRpcError(error) && error.code === "PRECONDITION_FAILED"
    ? (error.data?.reason ?? null)
    : null;
// What of the output shows on screen: ConPTY opens with control sequences
// alone (modes, cursor, clear).
const CONTROLS =
  // oxlint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_][^\x1b]*\x1b\\|\x1b[ -/]*[0-~]|[\x00-\x20\x7f]/g;
const visibleLength = (data: string): number =>
  data.replace(CONTROLS, "").length;
/**
 * Resize, and on Windows keep the screen where ConPTY's buffer is: it
 * repaints nothing on a resize (conpty.ts).
 */
const resizeTerminal = (
  term: TerminalView["term"],
  cols: number,
  rows: number
): void => {
  const buffer = term.buffer.active;
  if (
    document.documentElement.dataset.platform !== "win32" ||
    buffer.type === "alternate" ||
    (cols === term.cols && rows === term.rows)
  )
    return void term.resize(cols, rows);
  const top = buffer.length - term.rows;
  const cursor = { x: buffer.cursorX, y: buffer.cursorY };
  const rowCells = (y: number) => {
    const line = buffer.getLine(top + y);
    const cells: { x: number; width: number; text: string }[] = [];
    for (let x = 0; x < term.cols; x++) {
      const cell = line?.getCell(x);
      const width = cell?.getWidth() ?? 1;
      // The second half of a wide character.
      if (width === 0) continue;
      cells.push({ x, width, text: cell?.getChars() ?? "" });
    }
    let last = -1;
    cells.forEach((cell, i) => {
      if (cell.text !== "" || (y === cursor.y && cell.x < cursor.x)) last = i;
    });
    return {
      cells: cells.slice(0, last + 1),
      wrapped: y > 0 && line?.isWrapped === true,
    };
  };
  const screen: ScreenRow[] = [];
  // The cursor's own line (its start to its last wrapped row), as printed.
  let cursorLine: { text: string; width: number }[] = [];
  let cursorChars = 0;
  for (let y = 0; y <= cursor.y; y++) {
    const { cells, wrapped } = rowCells(y);
    if (!wrapped) {
      cursorChars = 0;
      cursorLine = [];
    }
    cursorChars +=
      y < cursor.y
        ? cells.length
        : cells.filter((cell) => cell.x < cursor.x).length;
    cursorLine.push(
      ...cells.map(({ text, width }) => ({ text: text || " ", width }))
    );
    screen.push({ widths: cells.map((cell) => cell.width), wrapped });
  }
  for (let y = cursor.y + 1; y < term.rows; y++) {
    const { cells, wrapped } = rowCells(y);
    if (!wrapped) break;
    cursorLine.push(
      ...cells.map(({ text, width }) => ({ text: text || " ", width }))
    );
  }
  const expected = conptyCursorRow(screen, cursorChars, cols, rows);
  const widthChanged = cols !== term.cols;
  term.resize(cols, rows);
  const after = term.buffer.active;
  const align = alignToConpty(
    rows,
    { x: after.cursorX, y: after.cursorY },
    expected
  );
  if (align) term.write(align);
  // Ghostty leaves the cursor's own line unwrapped: write it as ConPTY has it.
  const rewrap = widthChanged
    ? rewrapCursorLine(cursorLine, cursorChars, expected, cols, rows)
    : "";
  if (rewrap) term.write(rewrap);
};
/**
 * Input with a character's two UTF-16 halves in separate events (Windows
 * SendInput with KEYEVENTF_UNICODE, some IMEs and on-screen keyboards: a
 * key event per half) is joined into the character. Sent alone, each half
 * reaches the shell as U+FFFD.
 */
const joinSurrogates = () => {
  let high = "";
  return (data: string): string => {
    const joined = high + data;
    const last = joined.charCodeAt(joined.length - 1);
    high = last >= 0xd800 && last <= 0xdbff ? joined.slice(-1) : "";
    return high ? joined.slice(0, -1) : joined;
  };
};
// Outside the component: the React Compiler skips try/finally.
const writeMuted = (write: () => void, mute: (on: boolean) => void) => {
  mute(true);
  try {
    write();
  } finally {
    mute(false);
  }
};
const outputView = (
  view: TerminalView,
  write: OutputView["write"],
  replayed?: OutputView["replayed"]
): OutputView => ({
  replayed,
  get offset() {
    return view.offset;
  },
  set offset(n) {
    view.offset = n;
  },
  write,
  reset: async () => {
    if (view.offset !== undefined) await resetTerminal(view.term);
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
  /** The shell being started, while it has printed nothing (PowerShell takes seconds). */
  const [starting, setStarting] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  // A tab's shell starts the first time the tab is on screen: a restored tab
  // behind another, or in a closed panel, runs nothing until it is shown.
  const [shown, setShown] = useState(visible);
  if (visible && !shown) setShown(true);
  const bindings = useContext(TerminalActionBindingsContext);
  const handleKey = useEffectEvent(
    (
      event: KeyboardEvent,
      platform: "mac" | "windows" | "linux",
      term: Parameters<typeof terminalKeyHandler>[2]
    ) => terminalKeyHandler(platform, dispatch, term, bindings)(event)
  );
  const openUrl = useEffectEvent(onUrl);
  // Read when a shell starts, not a reason to start again: the tab learns
  // the shell it got (below), which must not restart it.
  const shellToStart = useEffectEvent(() => shell);
  const close = useEffectEvent(onClose);
  useEffect(() => {
    if (!shown) return;
    const abort = new AbortController();
    const finishStart = retainTerminalStart(key, id);
    let starting = false;
    // This run's shell has ended (no ConPTY left to repaint on a resize).
    let ended = false;
    // Windows: what the terminal sends while our screen has its new size and
    // ConPTY not yet (keys, focus reports, answers to its cursor queries).
    let held: string[] | null = null;
    // Writing replayed output: what the terminal answers to the old queries
    // in it (cursor position, ESC[6n) is not sent; the live shell would read
    // it as typed text.
    let replaying = false;
    const disposers: (() => void)[] = [];
    const cleanup = () => {
      for (const dispose of disposers.splice(0).reverse()) dispose();
    };
    // A shell being started shows what is starting until it prints something
    // visible (PowerShell can take seconds); a shell already running does not.
    const startingLabel = (shell: string | undefined) =>
      shell && shell !== "system"
        ? t("sessions.terminal.startingShell", {
            shell: t(`terminalShells.${shell}.label`),
          })
        : t("sessions.terminal.starting");
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
        // A shell already running (shown again) resizes like any other time.
        if (initialSize)
          resizeTerminal(view.term, initialSize.cols, initialSize.rows);
        // Its shell exited earlier (shown again after a visit elsewhere): the
        // output and Restart, not a fresh shell.
        if (terminalExited(key, `terminal:${id}`)) {
          ended = true;
          setExited(true);
        } else {
          starting = true;
          // The generation is the view's before anyone waiting on the start
          // resumes: a tab closed meanwhile closes the shell this started.
          const pending = transport.client.terminal
            .start({
              terminalId: id,
              conversationKey: key,
              conversation: conversationRefFromKey(key)!,
              generation: view.generation,
              ...(shellToStart() ? { shell: shellToStart() } : {}),
              cols: view.term.cols || 80,
              rows: view.term.rows || 24,
            })
            .then((start) => {
              if (start.success && start.state)
                view.generation = start.state.generation;
              return start;
            });
          view.starting = pending;
          const start = await pending;
          if (!start.success || !start.state)
            throw new Error(start.error ?? "Terminal failed");
          // Kept with the tab, so after an app restart it comes back with
          // the same shell (not whatever the default is by then).
          if (start.state.shell)
            rememberTerminalShell(key, `terminal:${id}`, start.state.shell);
          // A new shell (not one shown again): named now that it is known.
          if (start.created) setStarting(startingLabel(start.state.shell));
        }
        if (abort.signal.aborted) {
          cleanup();
          return;
        }
        const send = (data: string) =>
          void transport.client.terminal
            .write({
              terminalId: id,
              conversationKey: key,
              generation: view.generation!,
              data,
            })
            .catch(() => {});
        // Windows: the size ConPTY took and where in the output it took it.
        // Our screen resizes at exactly that point of the stream, so it has
        // every byte ConPTY sent before (the last \r\n too) and answers
        // the queries after it from the resized screen.
        let pending: { cols: number; rows: number; at: number } | null = null;
        let resizing = false;
        let again = false;
        const applyPending = () => {
          const size = pending;
          if (!size) return;
          pending = null;
          resizeTerminal(view.term, size.cols, size.rows);
          const waiting = held ?? [];
          held = null;
          for (const data of waiting) send(data);
          requestAnimationFrame(() => repaint(view.term));
          resizing = false;
          if (again) {
            again = false;
            fit();
          }
        };
        const joined = joinSurrogates();
        const input = view.term.onData((typed) => {
          if (replaying) return;
          const data = joined(typed);
          if (!data) return;
          // The terminal's answers (cursor position, device attributes) are
          // made at the right point of the output, so they go at once.
          const answer =
            data.startsWith("\x1b[") &&
            (/^.\[\d+;\d+R$/.test(data) || /^.\[\?[\d;]*c$/.test(data));
          // Keys and focus reports wait while a resize is on its way.
          if (held && !answer) held.push(data);
          else send(data);
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
            outputView(
              view,
              async (data, replay) => {
                if (visibleLength(data)) setStarting(null);
                if (pending && !replay && view.offset !== undefined) {
                  const bytes = new TextEncoder().encode(data);
                  const cut = pending.at - view.offset;
                  if (cut > 0 && cut < bytes.length) {
                    view.term.write(
                      new TextDecoder().decode(bytes.subarray(0, cut))
                    );
                    applyPending();
                    data = new TextDecoder().decode(bytes.subarray(cut));
                  } else if (cut <= 0) applyPending();
                }
                await writeTerminalData(
                  replay
                    ? {
                        // Answers come back inside write(), synchronously;
                        // keys typed meanwhile still go through.
                        write: (part) =>
                          writeMuted(
                            () => view.term.write(part),
                            (on) => {
                              replaying = on;
                            }
                          ),
                      }
                    : view.term,
                  data,
                  outputAbort!.signal
                );
                if (pending && replay) applyPending();
              },
              () => view.term.scrollToBottom()
            ),
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
                }\r\n\x1b[?25l`
              );
              ended = true;
              markTerminalExited(key, `terminal:${id}`, true);
              setStarting(null);
              setExited(true);
            },
            (e) => setError(failureText(e))
          );
        };
        disposers.push(() => {
          outputAbort?.abort();
          if (view.reconnect === connectOutput) view.reconnect = undefined;
        });
        view.reconnect = connectOutput;
        if (!ended) connectOutput();
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
        // Windows: PowerShell asks where the cursor is (ESC[6n) on the next
        // key or focus change and draws by our answer, so our screen must be
        // where ConPTY is when it answers. One resize per pause (a drag
        // resizes many times), one at a time; keys typed from the first size
        // change wait until our screen has the new size.
        const conpty = document.documentElement.dataset.platform === "win32";
        const changed = () => {
          const size = view.fit.proposeDimensions();
          return size &&
            (size.cols !== view.term.cols || size.rows !== view.term.rows)
            ? size
            : null;
        };
        const fit = () => {
          const live = !ended && view.generation != null;
          if (conpty && live && held == null && changed()) held = [];
          if (timer) clearTimeout(timer);
          timer = setTimeout(
            () => {
              if (resizing) {
                again = true;
                return;
              }
              if (!container.current?.getBoundingClientRect().width) return;
              const size = changed();
              if (!size) {
                // Back where it was: nothing to wait for.
                if (held && pending == null) {
                  const waiting = held;
                  held = null;
                  for (const data of waiting) send(data);
                }
                return;
              }
              if (conpty && live) {
                resizing = true;
                void transport.client.terminal
                  .resize({
                    terminalId: id,
                    conversationKey: key,
                    generation: view.generation!,
                    ...size,
                  })
                  .catch(() => false as const)
                  .then((at) => {
                    pending = {
                      cols: size.cols,
                      rows: size.rows,
                      at: typeof at === "number" ? at : -1,
                    };
                    // Already past that point (nothing in flight): now.
                    if ((view.offset ?? 0) >= pending.at) applyPending();
                  });
                return;
              }
              if (live) resizeTerminal(view.term, size.cols, size.rows);
              else view.term.resize(size.cols, size.rows);
              void transport.client.terminal.resize({
                terminalId: id,
                conversationKey: key,
                generation: view.generation!,
                ...size,
              });
              cancelAnimationFrame(paintFrame);
              paintFrame = requestAnimationFrame(() => repaint(view.term));
            },
            conpty ? 150 : 40
          );
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
        setStarting(null);
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
                  : failureText(e)
        );
      })
      .finally(finishStart);
    return () => {
      abort.abort();
      if (!starting) finishStart();
      cleanup();
    };
  }, [transport, key, id, t, run, shown]);
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
      // The old output scrolls up into the scrollback, so the new shell
      // starts on an empty screen: ConPTY (Windows) draws it from the top
      // row as if the screen were empty, and "Starting …" shows there.
      view.term.write(`\r${"\n".repeat(view.term.rows)}\x1b[H\x1b[?25h`);
      markTerminalExited(key, `terminal:${id}`, false);
      setExited(false);
      setRun((n) => n + 1);
    });
  };
  useEffect(() => {
    let live = true;
    // Hidden before it was ever shown: no screen, no shell, nothing to tell.
    const view = visible
      ? getTerminalView(`${key}:${id}`)
      : peekTerminalView(`${key}:${id}`);
    void view
      ?.then((view) => {
        if (!live) return;
        if (visible) {
          view.refit?.();
          afterMenusClose(() => {
            if (!live) return;
            // Shown by the keyboard (next tab, a closed neighbour), or picked
            // by its tab or the terminal icon: this terminal takes the keys, so
            // typing goes to it. Focus anywhere else (the chat box) stays.
            const focused = document.activeElement;
            if (
              focused == null ||
              focused === document.body ||
              focused.closest(
                '[data-slot="topbar"], [data-rail-mode], [role="tab"]'
              ) != null ||
              (focused.closest('[data-hotkeys="terminal"]') != null &&
                !container.current?.contains(focused))
            )
              view.term.focus();
          });
        } else if (view.generation != null)
          void transport.client.terminal.hide({
            conversationKey: key,
            terminalId: id,
            generation: view.generation,
          });
      })
      .catch((e) => {
        if (live) setError(failureText(e));
      });
    return () => {
      live = false;
    };
  }, [visible, key, id, transport]);
  // Dragging the chat | panel divider: the divider takes the focus on press
  // and drops it to the page when let go (the resize library keeps the
  // pointer events to itself). A terminal that had the keys takes them back.
  useEffect(() => {
    if (!visible) return;
    const gutter = "[data-pane-gutter]";
    let held = false;
    const moved = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const next =
        event.relatedTarget instanceof Element ? event.relatedTarget : null;
      if (container.current?.contains(target) && next?.closest(gutter))
        held = true;
      else if (held && target?.closest(gutter)) {
        held = false;
        if (next == null)
          void getTerminalView(`${key}:${id}`)
            .then((view) => view.term.focus())
            .catch(() => {});
      }
    };
    document.addEventListener("focusout", moved, true);
    return () => document.removeEventListener("focusout", moved, true);
  }, [visible, key, id]);
  return (
    <div
      className="relative flex size-full flex-col"
      data-hotkeys="terminal"
      role="region"
      aria-label={t("sessions.terminal.title")}
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
        {/* Ghostty makes its element contenteditable: Chromium would draw a
            second, text caret at its top-left (inherited by the textarea). */}
        <ContextMenuTrigger
          render={
            <div
              ref={container}
              className="min-h-0 flex-1 p-2 caret-transparent"
            />
          }
        />
        {starting ? (
          <p className="text-muted-foreground pointer-events-none absolute top-2 left-6 text-xs">
            {starting}
          </p>
        ) : null}
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
