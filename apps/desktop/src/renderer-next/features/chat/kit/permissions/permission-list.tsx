/**
 * Where pending permissions show (spec 02 §6.2): the sessions tray (the
 * selected descriptor's card, with a chip per descriptor when several are
 * pending) and the application-owned `PermissionList` (every descriptor no
 * mounted inline widget renders; bots and the notch).
 */
import type { PermissionRequest } from "@abacus-ai/agent";
import { useSelector } from "@tanstack/react-store";
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#next/lib/cn";

import { MarkdownLinksProvider } from "../../markdown/markdown";
import type { ChatRuntime } from "../../runtime/runtime";
import { useThreadStore } from "../../store/selectors";
import { toolKey, type PermissionDescriptor } from "../../store/thread-store";
import {
  ChatViewProvider,
  createInlineRegistry,
  useChatView,
  useOptionalChatView,
  type ChatViewContextValue,
} from "../context";
import { PermissionCard } from "./permission-card";
import { present } from "./presenters";
import { permissionSelection, selectPermission } from "./selection";

const inlineKeyOf = (descriptor: PermissionDescriptor): string | null =>
  descriptor.toolCallId == null
    ? null
    : toolKey(descriptor.subagentRunId, descriptor.toolCallId);

const useItems = (): PermissionDescriptor[] => {
  const { session } = useChatView();
  return useThreadStore(session, (state) => state.permissions.items);
};

/**
 * The id after `gone` in the previous order that is still pending, else the
 * first pending one: answering a chip moves on to its neighbour.
 */
const nextAfter = (
  previous: readonly string[],
  gone: string | null,
  current: readonly string[]
): string | null => {
  const at = gone == null ? -1 : previous.indexOf(gone);
  for (const id of previous.slice(at + 1)) if (current.includes(id)) return id;
  return current[0] ?? null;
};

/**
 * The tray's selected descriptor. A chip click (or a "needs you" row's
 * Show) selects through the shared store; answering does not move the
 * selection, so the card keeps showing its spinner, a `response_rejected`
 * message or the no-response timeout. Only when the selected descriptor
 * leaves `permission.pending` does the tray move to the next one in the
 * order it was shown (review r1 #30).
 */
const useTraySelection = (
  threadId: string,
  items: readonly PermissionDescriptor[]
): string | null => {
  const chosen = useSelector(
    permissionSelection,
    (state) => state[threadId] ?? null
  );
  const ids = items.map((item) => item.id);
  const [last, setLast] = useState<{ ids: string[]; id: string | null }>({
    ids,
    id: chosen,
  });
  let id: string | null;
  if (chosen != null && ids.includes(chosen) && chosen !== last.id)
    // A new choice (chip or Show).
    id = chosen;
  else if (last.id != null && ids.includes(last.id)) id = last.id;
  else id = nextAfter(last.ids, last.id, ids);
  if (
    id !== last.id ||
    ids.length !== last.ids.length ||
    ids.some((value, index) => value !== last.ids[index])
  )
    setLast({ ids, id });
  return id;
};

export const PermissionTray = ({
  autoFocus = false,
}: {
  autoFocus?: boolean;
}) => {
  const { t } = useTranslation();
  const { threadId } = useChatView();
  const items = useItems();
  const selectedId = useTraySelection(threadId, items);
  if (items.length === 0) return null;
  const selected = items.find((item) => item.id === selectedId) ?? items[0]!;
  return (
    <div className="flex flex-col gap-2" data-slot="permission-tray">
      {items.length > 1 ? (
        <div
          role="toolbar"
          aria-label={t("chat.permission.pending", { count: items.length })}
          className="flex flex-wrap gap-1.5"
        >
          {items.map((item) => {
            const model = present(
              item.metadata.abacus.request as PermissionRequest
            );
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={item.id === selected.id}
                onClick={() => selectPermission(threadId, item.id)}
                className={cn(
                  "focus-visible:ring-ring h-7 max-w-60 truncate rounded-full px-3 text-xs outline-none focus-visible:ring-2",
                  item.id === selected.id
                    ? "bg-foreground text-background"
                    : "text-foreground bg-[var(--chat-surface)] hover:bg-[var(--chat-surface-2)]"
                )}
              >
                {t(`chat.permission.chip.${model.chip}`, model.chipValues)}
              </button>
            );
          })}
        </div>
      ) : null}
      <PermissionCard
        key={selected.id}
        descriptor={selected}
        autoFocus={autoFocus}
      />
    </div>
  );
};

const ListedPermissions = () => {
  const { inline } = useChatView();
  const items = useItems();
  const registered = useSyncExternalStore(inline.subscribe, inline.keys);
  const listed = items.filter((item) => {
    const key = inlineKeyOf(item);
    return key == null || !registered.has(key);
  });
  if (listed.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-slot="permission-list">
      {listed.map((item) => (
        <PermissionCard key={item.id} descriptor={item} />
      ))}
    </div>
  );
};

export interface StandalonePermissionsProps {
  runtime: ChatRuntime;
  threadId: string;
  /** The card labels ("Allow" in the bot skin). Default "bot". */
  skin?: "bot" | "session";
  notchEnabled?: boolean;
  onOpenFile?: (absPath: string) => void;
}

/**
 * A thread's permission context outside a `ChatView` (the notch, phase 6):
 * the cards read the session, the runtime and the labels from here. No
 * inline widget is mounted, so every pending descriptor is listed.
 */
const StandalonePermissions = ({
  runtime,
  threadId,
  skin = "bot",
  notchEnabled = false,
  onOpenFile,
  children,
}: StandalonePermissionsProps & { children: ReactNode }) => {
  const session = runtime.session(threadId);
  const [inline] = useState(createInlineRegistry);
  useEffect(() => session.pin(), [session]);
  useEffect(() => {
    session.load().catch(() => {});
  }, [session]);
  const value: ChatViewContextValue = {
    threadId,
    skin,
    session,
    runtime,
    composer: {
      mode: "full",
      placeholder: "",
      attachmentsBase: null,
      showModeChip: false,
      model: null,
    },
    slots: {},
    workspaceRoot: null,
    ...(onOpenFile != null ? { onOpenFile } : {}),
    focused: false,
    notchEnabled,
    inline,
  };
  const links = {
    openFile: (path: string) =>
      onOpenFile != null
        ? onOpenFile(path)
        : void runtime.host.showItemInFolder(path),
    openExternal: (url: string) => void runtime.host.openExternal(url),
  };
  return (
    <ChatViewProvider value={value}>
      <MarkdownLinksProvider value={links}>{children}</MarkdownLinksProvider>
    </ChatViewProvider>
  );
};

/**
 * Every descriptor that no mounted inline widget renders (agent spec
 * §3.5.5). Inside a `ChatView` it reads the view; elsewhere (the notch)
 * pass `runtime` and `threadId` (review r1 #39).
 */
export const PermissionList = (
  props: Partial<StandalonePermissionsProps> = {}
) => {
  const view = useOptionalChatView();
  const { runtime, threadId } = props;
  if (runtime != null && threadId != null)
    return (
      <StandalonePermissions {...props} runtime={runtime} threadId={threadId}>
        <ListedPermissions />
      </StandalonePermissions>
    );
  if (view == null)
    throw new Error(
      "chat: PermissionList outside a ChatView needs runtime and threadId"
    );
  return <ListedPermissions />;
};
