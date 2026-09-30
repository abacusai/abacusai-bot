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

import { useMotionPreference } from "#next/lib/motion";
import { MessageScrollerProvider } from "#next/ui/message-scroller";

import { ThreadComposer } from "../composer/composer";
import { queueEditing, setQueueEditing } from "../composer/queue-editing";
import { cardEnter, composerExit } from "../motion";
import { Transcript } from "../scroller/transcript";
import { useThreadStore } from "../store/selectors";
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

/** One status line per milestone, at most one per 500 ms (§12.1). */
const Announcer = () => {
  const { t } = useTranslation();
  const { session } = useChatView();
  const outcomes = useThreadStore(session, (state) => state.runs.outcomes);
  const items = useThreadStore(session, (state) => state.permissions.items);
  const [text, setText] = useState("");
  const seen = useRef<{
    outcomes: Set<string>;
    permissions: Set<string>;
  } | null>(null);
  const queue = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (seen.current == null) {
      seen.current = {
        outcomes: new Set(outcomes.map((o) => o.runId)),
        permissions: new Set(items.map((i) => i.id)),
      };
      return;
    }
    for (const outcome of outcomes) {
      if (seen.current.outcomes.has(outcome.runId)) continue;
      seen.current.outcomes.add(outcome.runId);
      queue.current.push(
        outcome.kind === "success"
          ? t("chat.announce.finished")
          : outcome.kind === "cancelled"
            ? t("chat.announce.stopped")
            : t("chat.announce.error", {
                message: outcome.error?.message ?? "",
              })
      );
    }
    for (const item of items) {
      if (seen.current.permissions.has(item.id)) continue;
      seen.current.permissions.add(item.id);
      const model = present(item.metadata.abacus.request as PermissionRequest);
      queue.current.push(
        t("chat.announce.approval", {
          title: t(`chat.permission.title.${model.title}`, model.titleValues),
        })
      );
    }
    const flush = () => {
      const next = queue.current.shift();
      if (next == null) {
        timer.current = null;
        return;
      }
      setText(next);
      timer.current = setTimeout(flush, 500);
    };
    if (timer.current == null) flush();
  }, [outcomes, items, t]);
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

export const ChatLayout = ({ Messages, Input }: LayoutProps<unknown>) => {
  const { skin, slots, threadId } = useChatView();
  const Message = use(MessageComponentContext);
  const MessagesView = Messages as MessagesSlot;
  const InputView = Input as ComponentType;
  const editing = useSelector(queueEditing, (state) => state[threadId] ?? null);
  return (
    <MessageScrollerProvider
      autoScroll
      defaultScrollPosition="last-anchor"
      scrollPreviousItemPeek={64}
    >
      <div
        className="flex size-full min-h-0 flex-col"
        data-slot="chat-layout"
        data-skin={skin}
      >
        {slots.banner}
        <div className="relative flex min-h-0 flex-1 flex-col">
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
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-1.5 pb-4">
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
      </div>
    </MessageScrollerProvider>
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
  const [composerFocused, setComposerFocused] = useState(false);
  const tray = skin === "session" && pending;
  return (
    <div
      onFocusCapture={(event) => {
        setComposerFocused(
          (event.target as HTMLElement).tagName === "TEXTAREA"
        );
      }}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {tray ? (
          <motion.div
            key="tray"
            layout={pref === "full"}
            initial={{ opacity: 0, y: pref === "full" ? 8 : 0 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={cardEnter(pref)}
          >
            <PermissionTray autoFocus={composerFocused} />
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
