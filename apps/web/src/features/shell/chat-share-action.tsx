/**
 * Share in the title bar of a chat that made something shareable: the same
 * dialog as a files card row, for the chat's page or latest document.
 * Messages are read here, not in the route, so the route does not re-render
 * per stream tick.
 */
import type { UIMessage } from "@tanstack/ai-client";
import { useSelector, type Store } from "@tanstack/react-store";
import { Link2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { chatSharePath } from "#renderer/components/share/chat-share";
import {
  ShareButton,
  useCanShare,
} from "#renderer/components/share/share-row-button";
import { requestShare } from "#renderer/components/share/share-store";

import { useTopBarActions, type TopBarAction } from "./top-bar-slots";

const Registered = ({ path }: { path: string }) => {
  const { t } = useTranslation();
  const label = t("share.action");
  // The compiler keeps the list stable while the path and label are.
  const actions: TopBarAction[] = [
    {
      id: "share",
      label,
      icon: <Link2 />,
      render: (
        <ShareButton
          path={path}
          from="header"
          className="titlebar-nodrag self-center"
        />
      ),
      onSelect: () => requestShare(path, "header"),
    },
  ];
  useTopBarActions(actions);
  return null;
};

interface ChatShareProps<S extends { messages: readonly UIMessage[] }> {
  /** The chat's host store (its messages). */
  hostStore: Store<S>;
  workspaceRoot: string | null;
}

const ChatShare = <S extends { messages: readonly UIMessage[] }>({
  hostStore,
  workspaceRoot,
}: ChatShareProps<S>) => {
  const path = useSelector(hostStore, (state) =>
    chatSharePath(state.messages, workspaceRoot)
  );
  return path == null ? null : <Registered path={path} />;
};

/** Registers the chat's Share while it is mounted and the chat has a file to share. */
export const ChatShareAction = <S extends { messages: readonly UIMessage[] }>(
  props: ChatShareProps<S>
) => (useCanShare() ? <ChatShare {...props} /> : null);
