import type { WorkspaceRow } from "@abacus-ai/contract/contract";
import { useLocation } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { Paperclip, SquarePen, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { NavList } from "#renderer/components/nav-list";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { Button } from "#renderer/ui/button";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
} from "#renderer/ui/context-menu";
import { toast } from "#renderer/ui/toast";

import {
  hasDraftContent,
  removeSessionDraft,
  sessionDraftsStore,
} from "./session-drafts";
import { newStartDraft, startDraftStore } from "./start-session";

const relativeTime = (updatedAt: number, now: number, language: string) => {
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60000));
  const format = new Intl.RelativeTimeFormat(language, {
    numeric: "auto",
    style: "narrow",
  });
  if (!minutes) return format.format(0, "second");
  if (minutes < 60) return format.format(-minutes, "minute");
  if (minutes < 1440) return format.format(-Math.floor(minutes / 60), "hour");
  return format.format(-Math.floor(minutes / 1440), "day");
};

export const SessionDraftsSection = ({
  workspaces,
}: {
  workspaces: readonly WorkspaceRow[];
}) => {
  const { t, i18n } = useTranslation();
  const state = useSelector(sessionDraftsStore, (s) => s);
  const pathname = useLocation({ select: (s) => s.pathname });
  const navigate = useAppNavigate();
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const drafts = Object.values(state.drafts)
    .filter((d) => d.stage !== "handed-off" && hasDraftContent(d.composer))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  if (!drafts.length) return null;
  const discard = (id: string) => {
    const active = startDraftStore.state.id === id;
    if (active) startDraftStore.setState(newStartDraft);
    const undo = removeSessionDraft(id);
    if (active && pathname === "/sessions/new") {
      const fresh = startDraftStore.state.id;
      void navigate({
        to: "/sessions/new",
        search: { draft: fresh },
        replace: true,
      });
    }
    const toastId = toast.add({
      title: t("sessions.drafts.deleted"),
      timeout: 6000,
      actionProps: {
        children: t("sessions.drafts.undo"),
        onClick: () => {
          if (undo())
            void navigate({ to: "/sessions/new", search: { draft: id } });
          toast.close(toastId);
        },
      },
    });
  };
  return (
    <NavList.Group
      label={t("sessions.drafts.heading")}
      icon={<SquarePen className="size-3" />}
      meta={drafts.length}
      open={open}
      onOpenChange={setOpen}
    >
      <div data-slot="session-drafts" className="flex flex-col gap-0.5">
        {drafts.map((draft) => {
          const preview =
            draft.composer.text.trim().split("\n")[0] ||
            t("sessions.drafts.untitled");
          const workspace = workspaces.find(
            (w) => w.id === draft.workspaceId
          )?.label;
          const count = draft.composer.attachments.length;
          return (
            <ContextMenu key={draft.id}>
              <ContextMenuTrigger
                render={<div className="group/draft relative" />}
              >
                <NavList.Item
                  to="/sessions/new"
                  search={{ draft: draft.id }}
                  active={
                    pathname === "/sessions/new" && state.activeId === draft.id
                  }
                  hint={
                    draft.composer.text
                      .trim()
                      .split("\n")
                      .slice(0, 3)
                      .join("\n") || preview
                  }
                  className="h-auto min-h-(--row-h) py-1 pr-7"
                  title={
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate">{preview}</span>
                      <span className="text-muted-foreground truncate text-[11px]">
                        {workspace}
                      </span>
                    </span>
                  }
                  meta={
                    <span className="flex items-center gap-1">
                      {count ? (
                        <>
                          <Paperclip className="size-3" />
                          <span>{count}</span>
                        </>
                      ) : null}
                      <time dateTime={new Date(draft.updatedAt).toISOString()}>
                        {relativeTime(draft.updatedAt, now, i18n.language)}
                      </time>
                    </span>
                  }
                />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="absolute top-1/2 right-0.5 -translate-y-1/2 opacity-0 group-focus-within/draft:opacity-100 group-hover/draft:opacity-100"
                  aria-label={t("sessions.drafts.discard", { name: preview })}
                  onClick={() => discard(draft.id)}
                >
                  <X />
                </Button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuGroup>
                  <ContextMenuItem onClick={() => discard(draft.id)}>
                    {t("sessions.drafts.discardMenu")}
                  </ContextMenuItem>
                </ContextMenuGroup>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
    </NavList.Group>
  );
};
