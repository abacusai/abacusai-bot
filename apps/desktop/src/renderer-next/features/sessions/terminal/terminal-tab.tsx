import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { repaint } from "#next/components/terminal/ghostty";
import {
  terminalKeyHandler,
  type TerminalAction,
} from "#next/components/terminal/keys";
import type { SessionRow } from "#shared/contract/rows";
import {
  sessionConversationKey,
  sessionConversationRef,
} from "#shared/conversation-scope";

import { useSessionsTransport } from "../data/queries";
import { pumpOutput } from "./output-pump";
import { getTerminalView } from "./terminal-registry";
export const TerminalTab = ({
  row,
  id,
  visible,
  onClose,
  dispatch,
}: {
  row: SessionRow;
  id: string;
  visible: boolean;
  onClose: () => void;
  dispatch: (id: TerminalAction) => void;
}) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const container = useRef<HTMLDivElement>(null);
  const key = sessionConversationKey(row.workspaceId, row.id);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  const action = useEffectEvent(dispatch);
  const close = useEffectEvent(onClose);
  useEffect(() => {
    const abort = new AbortController();
    let cleanup = () => {};
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    void getTerminalView(`${key}:${id}`)
      .then(async (view) => {
        if (abort.signal.aborted) return;
        container.current?.append(view.element);
        const start = await transport.client.terminal.start({
          terminalId: id,
          conversationKey: key,
          conversation: sessionConversationRef(row.workspaceId, row.id),
          generation: view.generation,
          cols: view.term.cols || 80,
          rows: view.term.rows || 24,
        });
        if (!start.success || !start.state)
          throw new Error(start.error ?? "Terminal failed");
        view.generation = start.state.generation;
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
              write: (data) => {
                view.received += data.length;
                view.term.write(data);
              },
              reset: () => view.term.reset(),
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
        view.reconnect = connectOutput;
        connectOutput();
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
        if (container.current) observer.observe(container.current);
        fit();
        view.term.focus();
        cleanup = () => {
          outputAbort?.abort();
          view.reconnect = undefined;
          observer.disconnect();
          input.dispose();
          if (timer) clearTimeout(timer);
          view.element.remove();
        };
      })
      .catch((e) => setError(String(e)));
    return () => {
      abort.abort();
      cleanup();
      if (exitTimer) clearTimeout(exitTimer);
    };
  }, [transport, key, id, row.workspaceId, row.id, t]);
  useEffect(() => {
    if (!visible)
      void getTerminalView(`${key}:${id}`).then((view) => {
        if (view.generation != null)
          void transport.client.terminal.hide({
            conversationKey: key,
            terminalId: id,
            generation: view.generation,
          });
      });
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
