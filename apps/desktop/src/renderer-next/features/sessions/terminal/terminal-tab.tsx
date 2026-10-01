import { UrlRegexProvider, OSC8LinkProvider } from "ghostty-web";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { repaint, writeTerminalData } from "#next/components/terminal/ghostty";
import {
  terminalKeyHandler,
  type TerminalAction,
} from "#next/components/terminal/keys";
import { followNotices } from "#next/data/queries/live";
import type { SessionRow } from "#shared/contract/rows";
import {
  sessionConversationKey,
  sessionConversationRef,
} from "#shared/conversation-scope";
import { installMouseReporting } from "#shared/terminal/mouse-compat";

import { useSessionsTransport } from "../data/queries";
import { pumpOutput } from "./output-pump";
import { getTerminalView } from "./terminal-registry";
export const TerminalTab = ({
  row,
  id,
  visible,
  onClose,
  dispatch,
  onUrl,
  shell,
}: {
  row: SessionRow;
  id: string;
  visible: boolean;
  onClose: () => void;
  dispatch: (id: TerminalAction) => void;
  onUrl: (url: string) => void;
  shell?: import("#shared/terminal-shells").TerminalShellId;
}) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const container = useRef<HTMLDivElement>(null);
  const key = sessionConversationKey(row.workspaceId, row.id);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  const action = useEffectEvent(dispatch);
  const openUrl = useEffectEvent(onUrl);
  const close = useEffectEvent(onClose);
  useEffect(() => {
    const abort = new AbortController();
    const disposers: (() => void)[] = [];
    const cleanup = () => {
      for (const dispose of disposers.splice(0).reverse()) dispose();
    };
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    void getTerminalView(`${key}:${id}`)
      .then(async (view) => {
        if (abort.signal.aborted) return;
        const host = container.current;
        host?.append(view.element);
        disposers.push(() => {
          if (view.element.parentElement === host) view.element.remove();
        });
        const initialSize = view.fit.proposeDimensions();
        if (initialSize) view.term.resize(initialSize.cols, initialSize.rows);
        const start = await transport.client.terminal.start({
          terminalId: id,
          conversationKey: key,
          conversation: sessionConversationRef(row.workspaceId, row.id),
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
        const platform = document.documentElement.dataset.platform;
        view.term.attachCustomKeyEventHandler(
          terminalKeyHandler(
            platform === "darwin"
              ? "mac"
              : platform === "win32"
                ? "windows"
                : "linux",
            (id) => action(id),
            view.term
          )
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
        let outputAbort: AbortController | undefined;
        const connectOutput = () => {
          outputAbort?.abort();
          outputAbort = new AbortController();
          void pumpOutput(
            {
              get offset() {
                return view.offset;
              },
              set offset(n) {
                view.offset = n;
              },
              write: async (data) => {
                view.received += data.length;
                await writeTerminalData(view.term, data, outputAbort!.signal);
              },
              reset: () => {
                if (view.offset !== undefined) view.term.reset();
              },
            },
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
                `\r\n${t("sessions.terminal.exited", { code: chunk.exitCode ?? "" })}\r\n`
              );
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
            repaint(view.term);
          }, 40);
        };
        const observer = new ResizeObserver(fit);
        disposers.push(() => {
          observer.disconnect();
          if (timer) clearTimeout(timer);
        });
        if (container.current) observer.observe(container.current);
        fit();
        view.term.focus();
      })
      .catch((e) => {
        cleanup();
        if (!abort.signal.aborted) setError(String(e));
      });
    return () => {
      abort.abort();
      cleanup();
      if (exitTimer) clearTimeout(exitTimer);
    };
  }, [transport, key, id, row.workspaceId, row.id, t, shell]);
  useEffect(() => {
    let live = true;
    if (!visible)
      void getTerminalView(`${key}:${id}`).then((view) => {
        if (live && view.generation != null)
          void transport.client.terminal.hide({
            conversationKey: key,
            terminalId: id,
            generation: view.generation,
          });
      });
    return () => {
      live = false;
    };
  }, [visible, key, id, transport]);
  return (
    <div
      className="flex size-full flex-col"
      role="region"
      aria-label={t("sessions.terminal.title")}
      onFocusCapture={() => {
        focused.current = true;
      }}
      onBlurCapture={() => {
        focused.current = false;
      }}
    >
      {error ? <p role="alert">{error}</p> : null}
      <div ref={container} className="min-h-0 flex-1 p-2" />
    </div>
  );
};
