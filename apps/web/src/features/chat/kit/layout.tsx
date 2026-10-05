/**
 * `ChatLayout` (spec 02 §5.1): the transcript, notices, the permission list
 * (bots), the queue slot and the input slot, which is the composer or, in
 * sessions, the permission tray taking it over (§6.2, motion §9.1). Plus the
 * status region that announces run milestones once each (§12.1).
 */
import type { PermissionRequest } from "@abacus-ai/agent";
import type { UIMessage } from "@tanstack/ai-client";
import type { LayoutProps } from "@tanstack/ai-react/ui";
import { useSelector } from "@tanstack/react-store";
import { AnimatePresence, motion } from "motion/react";
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { Spinner } from "#renderer/components/spinner";
import { useAppHotkey } from "#renderer/lib/hotkeys";
import { useMotionPreference } from "#renderer/lib/motion";
import { Button } from "#renderer/ui/button";
import {
  MessageScrollerProvider,
  useMessageScrollerScrollable,
} from "#renderer/ui/message-scroller";

import { ThreadComposer } from "../composer/composer";
import { queueEditing, setQueueEditing } from "../composer/queue-editing";
import { cardEnter, composerExit } from "../motion";
import { Transcript } from "../scroller/transcript";
import { useBusy, useHost, useThreadStore } from "../store/selectors";
import type { RunOutcomeRecord } from "../store/thread-store";
import { useChatView } from "./context";
import { PermissionList, PermissionTray } from "./permissions/permission-list";
import { present } from "./permissions/presenters";
import { QueueSlot } from "./queue-slot";
import { NoticeRow } from "./status/status";

/** The skin's message widget, for the transcript's rows. */
const MessageComponentContext = createContext<ComponentType<{
  message: UIMessage;
}> | null>(null);
export const MessageComponentProvider = MessageComponentContext.Provider;

type MessagesSlot = ComponentType<{
  children?: (messages: UIMessage[]) => ReactNode;
}>;

const Notices = () => {
  const { session } = useChatView();
  const notices = useThreadStore(session, (state) => state.notices);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const shown = notices.filter(
    (notice) => !dismissed.has(`${notice.key}:${notice.seq}`)
  );
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 px-4" data-slot="notices">
      {shown.map((notice) => (
        <NoticeRow
          key={notice.key}
          notice={notice}
          onDismiss={() =>
            setDismissed(
              (set) => new Set([...set, `${notice.key}:${notice.seq}`])
            )
          }
        />
      ))}
    </div>
  );
};

/** Recorded by the live post-hook, not merged from a hydrate or a page. */
const isLive = (outcome: RunOutcomeRecord): boolean =>
  (outcome as RunOutcomeRecord & { live?: boolean }).live === true;

const ANNOUNCE_GAP_MS = 500;

/**
 * One status line per milestone, each announced once, at most one per
 * 500 ms (§12.1): a live run's terminal (never the old runs a history page
 * or a new generation's snapshot brings in, review r1 #21), a new approval,
 * and "{n} new messages" for messages that arrive while the reader is away
 * from the end. A burst of new messages is one announcement with the latest
 * count.
 */
const Announcer = () => {
  const { t } = useTranslation();
  const { session } = useChatView();
  const outcomes = useThreadStore(session, (state) => state.runs.outcomes);
  const items = useThreadStore(session, (state) => state.permissions.items);
  const messages = useHost(session, (state) => state.messages);
  const scrollable = useMessageScrollerScrollable();
  const [text, setText] = useState("");
  const seen = useRef<{
    outcomes: Set<string>;
    permissions: Set<string>;
    lastMessageId: string | null;
    count: number;
    unread: number;
  } | null>(null);
  const queue = useRef<Array<{ kind: "milestone" | "new"; text: string }>>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const awayFromEnd = scrollable.end;
  useEffect(() => {
    const last = messages.at(-1)?.id ?? null;
    if (seen.current == null) {
      seen.current = {
        outcomes: new Set(outcomes.map((o) => o.runId)),
        permissions: new Set(items.map((i) => i.id)),
        lastMessageId: last,
        count: messages.length,
        unread: 0,
      };
      return;
    }
    const state = seen.current;
    for (const outcome of outcomes) {
      if (state.outcomes.has(outcome.runId)) continue;
      state.outcomes.add(outcome.runId);
      if (!isLive(outcome)) continue;
      queue.current.push({
        kind: "milestone",
        text:
          outcome.kind === "success"
            ? t("chat.announce.finished")
            : outcome.kind === "cancelled"
              ? t("chat.announce.stopped")
              : t("chat.announce.error", {
                  message: outcome.error?.message ?? "",
                }),
      });
    }
    for (const item of items) {
      if (state.permissions.has(item.id)) continue;
      state.permissions.add(item.id);
      const model = present(item.metadata.abacus.request as PermissionRequest);
      queue.current.push({
        kind: "milestone",
        text: t("chat.announce.approval", {
          title: t(`chat.permission.title.${model.title}`, model.titleValues),
        }),
      });
    }
    // Appended at the end (a page prepends and keeps the last id).
    if (last !== state.lastMessageId) {
      const added = Math.max(0, messages.length - state.count);
      const fromOthers =
        messages.at(-1)?.role !== "user" &&
        messages.at(-1)?.metadata?.abacus?.pending !== true;
      if (added > 0 && fromOthers && awayFromEnd) {
        state.unread += added;
        const next = {
          kind: "new" as const,
          text: t("chat.announce.newMessages", { count: state.unread }),
        };
        const index = queue.current.findIndex((entry) => entry.kind === "new");
        if (index === -1) queue.current.push(next);
        else queue.current[index] = next;
      }
    }
    if (!awayFromEnd) state.unread = 0;
    state.outcomes = new Set(outcomes.map((o) => o.runId));
    state.permissions = new Set(items.map((i) => i.id));
    state.lastMessageId = last;
    state.count = messages.length;
    const flush = () => {
      const next = queue.current.shift();
      if (next == null) {
        timer.current = null;
        return;
      }
      setText(next.text);
      timer.current = setTimeout(flush, ANNOUNCE_GAP_MS);
    };
    if (timer.current == null && queue.current.length > 0)
      timer.current = setTimeout(flush, ANNOUNCE_GAP_MS);
  }, [outcomes, items, messages, awayFromEnd, t]);
  useEffect(
    () => () => {
      if (timer.current != null) clearTimeout(timer.current);
    },
    []
  );
  return (
    <div
      role="status"
      aria-live="polite"
      className="sr-only"
      data-slot="chat-announcer"
    >
      {text}
    </div>
  );
};

/**
 * `Mod+.` stops the run (§8.4): one registration per mounted `ChatView`,
 * through the app's hotkey wrapper, enabled only while this view is the
 * focused thread and busy.
 */
const StopHotkey = () => {
  const { session, focused, composer } = useChatView();
  const busy = useBusy(session, composer.turnBusy === true);
  useAppHotkey("Mod+.", () => void session.cancel().catch(() => {}), {
    enabled: busy && focused,
  });
  return null;
};

export const ChatLayout = ({ Messages, Input }: LayoutProps<unknown>) => {
  const { skin, slots, threadId } = useChatView();
  const Message = use(MessageComponentContext);
  const MessagesView = Messages as MessagesSlot;
  const InputView = Input as ComponentType;
  const editing = useSelector(queueEditing, (state) => state[threadId] ?? null);
  return (
    <MessageScrollerProvider
      autoScroll
      defaultScrollPosition="end"
      scrollPreviousItemPeek={64}
    >
      <div
        className="flex size-full min-h-0 min-w-0 flex-col"
        data-slot="chat-layout"
        data-skin={skin}
      >
        {slots.banner}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <MessagesView>
            {(messages) =>
              messages.length === 0 && slots.empty != null ? (
                <div className="flex flex-1 items-center justify-center">
                  {slots.empty}
                </div>
              ) : Message == null ? null : (
                <Transcript messages={messages} Message={Message} />
              )
            }
          </MessagesView>
        </div>
        <div className="mx-auto flex w-full max-w-[720px] min-w-0 flex-col gap-1.5 pb-4">
          <Notices />
          {skin === "bot" ? (
            <div className="px-4">
              <PermissionList />
            </div>
          ) : null}
          <QueueSlot
            editingId={editing}
            onEditingChange={(id) => setQueueEditing(threadId, id)}
          />
          <div className="px-4">
            <InputView />
          </div>
        </div>
        <Announcer />
        <StopHotkey />
      </div>
    </MessageScrollerProvider>
  );
};

/** Stop while the permission tray has taken the composer's place (§4.5). */
const TrayStop = () => {
  const { t } = useTranslation();
  const { session, composer } = useChatView();
  const busy = useBusy(session, composer.turnBusy === true);
  const cancelling = useHost(session, (state) => state.cancelling);
  if (!busy) return null;
  return (
    <div className="flex justify-end">
      <Button
        variant="ghost"
        size="sm"
        disabled={cancelling}
        onClick={() => void session.cancel().catch(() => {})}
      >
        {cancelling ? (
          <Spinner aria-hidden />
        ) : (
          <span aria-hidden className="size-2 rounded-[2px] bg-current" />
        )}
        {t("chat.composer.stop")}
      </Button>
    </div>
  );
};

/** The input slot: the composer, or (sessions) the tray that takes it over. */
export const ComposerSlot = () => {
  const { skin, session } = useChatView();
  const pending = useThreadStore(
    session,
    (state) => state.permissions.items.length > 0
  );
  const pref = useMotionPreference();
  const slot = useRef<HTMLDivElement>(null);
  const tray = skin === "session" && pending;
  // Whether the composer had focus when the tray took its place (§6.4): read
  // when the tray appears, not remembered from an earlier focus event.
  const [trayFocus, setTrayFocus] = useState<{
    tray: boolean;
    focus: boolean;
  }>({ tray, focus: false });
  if (trayFocus.tray !== tray) {
    const active =
      typeof document === "undefined" ? null : document.activeElement;
    setTrayFocus({
      tray,
      focus:
        tray &&
        active instanceof HTMLTextAreaElement &&
        active.closest('[data-slot="composer"]') != null,
    });
  }
  return (
    <div ref={slot}>
      <AnimatePresence mode="popLayout" initial={false}>
        {tray ? (
          <motion.div
            key="tray"
            layout={pref === "full"}
            initial={{ opacity: 0, y: pref === "full" ? 8 : 0 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={cardEnter(pref)}
            className="flex flex-col gap-1.5"
          >
            <PermissionTray autoFocus={trayFocus.focus} />
            <TrayStop />
          </motion.div>
        ) : (
          <motion.div
            key="composer"
            layout={pref === "full"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={composerExit(pref)}
          >
            <ThreadComposer />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
