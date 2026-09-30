/**
 * `ChatView` (spec 02 §2): the whole thread view. It pins the thread's
 * session while mounted, renders skeleton rows until the session is ready
 * (never an empty log, §3.2), then the skin's kit over `useThreadHost`.
 */
import "../chat.css";
import type { UIMessage } from "@tanstack/ai-client";
import { useEffect, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "#next/components/empty-state";
import { Button } from "#next/ui/button";
import { Skeleton } from "#next/ui/skeleton";

import { CODE_THEME_CSS } from "../markdown/highlighter";
import { MarkdownLinksProvider } from "../markdown/markdown";
import { prefetchMath } from "../markdown/math";
import { useThreadHost } from "../runtime/host";
import type { ChatRuntime } from "../runtime/runtime";
import { useHost } from "../store/selectors";
import {
  ChatViewProvider,
  createInlineRegistry,
  useChatView,
  type ChatViewSlots,
  type ComposerConfig,
  type ChatViewContextValue,
} from "./context";
import { MessageComponentProvider } from "./layout";
import { KitPartsProvider } from "./message-scope";
import { BotUI, SessionUI } from "./ui";

export interface ChatViewProps {
  threadId: string;
  skin: "bot" | "session";
  runtime: ChatRuntime;
  slots?: ChatViewSlots;
  composer: ComposerConfig;
  workspaceRoot: string | null;
  onOpenFile?: (absPath: string) => void;
  onOpenSubagent?: (subagentRunId: string) => void;
  /** Whether this is the focused thread view (Mod+. applies here). */
  focused?: boolean;
  notchEnabled?: boolean;
}

const LoadingRows = () => (
  <div
    className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 pt-8"
    data-slot="chat-loading"
    aria-busy
  >
    <Skeleton className="h-9 w-2/5 self-end rounded-2xl" />
    <Skeleton className="h-16 w-3/4 rounded-2xl" />
    <Skeleton className="h-9 w-1/3 self-end rounded-2xl" />
    <Skeleton className="h-24 w-4/5 rounded-2xl" />
  </div>
);

const Failed = ({
  onRetry,
  notFound,
  skin,
}: {
  onRetry(): void;
  notFound: boolean;
  skin: "bot" | "session";
}) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 items-center justify-center" role="status">
      <EmptyState
        icon={skin === "bot" ? "bots" : "sessions"}
        title={notFound ? t("chat.view.gone") : t("chat.view.unavailable")}
        action={
          notFound ? undefined : (
            <Button variant="secondary" onClick={onRetry}>
              {t("chat.view.retry")}
            </Button>
          )
        }
      />
    </div>
  );
};

let themeInjected = false;
const injectTheme = (): void => {
  if (themeInjected || typeof document === "undefined") return;
  themeInjected = true;
  const style = document.createElement("style");
  style.dataset.chatCodeTheme = "";
  style.textContent = CODE_THEME_CSS;
  document.head.append(style);
};

const Kit = ({ skin }: { skin: "bot" | "session" }) => {
  const { session } = useChatView();
  const host = useThreadHost(session);
  const UI = skin === "bot" ? BotUI : SessionUI;
  const Message = UI.Message as ComponentType<{ message: UIMessage }>;
  return (
    <MessageComponentProvider value={Message}>
      <KitPartsProvider value={UI}>
        <UI.Chat chat={host} />
      </KitPartsProvider>
    </MessageComponentProvider>
  );
};

export const ChatView = (props: ChatViewProps) => {
  const { threadId, skin, runtime } = props;
  const session = runtime.session(threadId);
  const [inline] = useState(createInlineRegistry);
  const ready = useHost(session, (state) => state.ready);
  const phase = useHost(session, (state) => state.phase);
  const notFound = useHost(session, (state) => state.notFound);
  useEffect(() => session.pin(), [session]);
  useEffect(() => {
    injectTheme();
    prefetchMath();
    session.load().catch(() => {});
  }, [session]);
  const value: ChatViewContextValue = {
    threadId,
    skin,
    session,
    runtime,
    composer: props.composer,
    slots: props.slots ?? {},
    workspaceRoot: props.workspaceRoot,
    ...(props.onOpenFile != null ? { onOpenFile: props.onOpenFile } : {}),
    ...(props.onOpenSubagent != null
      ? { onOpenSubagent: props.onOpenSubagent }
      : {}),
    focused: props.focused ?? true,
    notchEnabled: props.notchEnabled ?? false,
    inline,
  };
  const links = {
    openFile: (path: string) =>
      props.onOpenFile != null
        ? props.onOpenFile(path)
        : void runtime.host.showItemInFolder(path),
    openExternal: (url: string) => void runtime.host.openExternal(url),
  };
  return (
    <ChatViewProvider value={value}>
      <MarkdownLinksProvider value={links}>
        <div
          className="flex size-full min-h-0 flex-col"
          data-slot="chat-view"
          data-skin={skin}
          data-thread={threadId}
        >
          {ready ? (
            <Kit key={threadId} skin={skin} />
          ) : phase === "error" ? (
            <Failed
              skin={skin}
              notFound={notFound}
              onRetry={() => void session.reconnect().catch(() => {})}
            />
          ) : (
            <LoadingRows />
          )}
        </div>
      </MarkdownLinksProvider>
    </ChatViewProvider>
  );
};
