import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { useLiveQuery } from "@tanstack/react-db";
import { formatForDisplay } from "@tanstack/react-hotkeys";
import { useRouterState } from "@tanstack/react-router";
import { useStore } from "@tanstack/react-store";
import {
  Bot,
  Clock,
  Folder,
  GitCompare,
  Globe,
  Home,
  LayoutPanelLeft,
  MessageSquare,
  Moon,
  Plus,
  Settings,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { useContext, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { BotAvatar } from "#renderer/components/bot-avatar";
import { useCollections } from "#renderer/data/db";
import { isListedSession, isListedWorkspace } from "#renderer/data/db/filters";
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { resolveLook } from "#renderer/lib/bots/avatar";
import { dispatchHotkeyAction } from "#renderer/lib/hotkeys";
import { ActionBindingsContext } from "#renderer/lib/keyboard/action-bindings";
import {
  AREA_HOME,
  RAIL_AREAS,
  SETTINGS_PAGES,
} from "#renderer/lib/navigation/areas";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "#renderer/ui/command";
import { Kbd } from "#renderer/ui/kbd";

import {
  rankCommands,
  highlightCommand,
  type SearchableCommand,
} from "./command-results";
import { setCommandOpen, shellStore } from "./shell-store";
import { useSessionPanelTabs } from "./use-panel";

/** Query the lazy collections only while the existing dialog is open. */
export const CommandMenu = () => {
  const { t } = useTranslation();
  const open = useStore(shellStore, (state) => state.commandOpen);
  return (
    <CommandDialog
      open={open}
      onOpenChange={setCommandOpen}
      title={t("shell.command.title")}
      description={t("shell.command.placeholder")}
      className="sm:max-w-xl"
    >
      {open && <CommandMenuBody />}
    </CommandDialog>
  );
};
interface Entry extends SearchableCommand {
  icon: LucideIcon;
  avatar?: ReactNode;
  shortcut?: string;
  run(): void | Promise<void>;
}
const CommandMenuBody = () => {
  const { t } = useTranslation();
  const collections = useCollections();
  const prefs = usePrefs();
  const updatePrefs = useUpdatePrefs();
  const navigate = useAppNavigate();
  const navigateSession = useAppNavigate({ from: "/sessions/$sessionId" });
  const bindings = useContext(ActionBindingsContext);
  const shortcut = (id: string, fallback: string) => {
    const chord = bindings?.[id] === undefined ? fallback : bindings[id];
    return chord
      ? formatForDisplay(chord as never, {
          platform:
            document.documentElement.dataset.platform === "darwin"
              ? "mac"
              : "windows",
        })
      : undefined;
  };
  const [query, setQuery] = useState("");
  const { data: bots, isLoading: botsLoading } = useLiveQuery(collections.bots);
  const { data: sessions, isLoading: sessionsLoading } = useLiveQuery(
    collections.sessions
  );
  const { data: workspaces, isLoading: workspacesLoading } = useLiveQuery(
    collections.workspaces
  );
  const sessionId = useRouterState({
    select: (state) =>
      state.matches.flatMap((match) =>
        "sessionId" in match.params ? [match.params.sessionId] : []
      )[0],
  });
  const current = sessions?.find((session) => session.id === sessionId);
  const key = current
    ? sessionConversationKey(current.workspaceId, current.id)
    : "";
  const tabs = useSessionPanelTabs(key || null).tabs;
  const listed = (sessions ?? [])
    .filter(isListedSession)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const recent = listed.slice(0, 5);
  const recentIds = new Set(recent.map((session) => session.id));
  const entries: Entry[] = [
    ...listed.map((session): Entry => ({
      id: `session:${session.id}`,
      title: session.label || t("sessions.untitled"),
      group: recentIds.has(session.id) ? "recent" : "sessions",
      icon: recentIds.has(session.id) ? Clock : MessageSquare,
      keywords: [
        t("shell.command.groups.sessions"),
        ...(workspaces ?? [])
          .filter((workspace) => workspace.id === session.workspaceId)
          .map((workspace) => workspace.label),
      ],
      run: () =>
        navigate({
          to: "/sessions/$sessionId",
          params: { sessionId: session.id },
          transition: "nav-lateral",
        }),
    })),
    ...(bots ?? []).map((bot): Entry => ({
      id: `bot:${bot.id}`,
      avatar: <BotAvatar look={resolveLook(bot)} size={20} animate={false} />,
      title: bot.name,
      group: "bots",
      icon: Bot,
      keywords: [t("shell.command.groups.bots")],
      run: () =>
        navigate({
          to: "/bots/$botId",
          params: { botId: bot.id },
          transition: "nav-lateral",
        }),
    })),
    ...(workspaces ?? []).filter(isListedWorkspace).map((workspace): Entry => ({
      id: `workspace:${workspace.id}`,
      title: workspace.label,
      group: "workspaces",
      icon: Folder,
      keywords: [t("shell.command.groups.workspaces")],
      run: () =>
        navigate({
          to: "/sessions/new",
          search: { workspace: workspace.id },
          transition: "nav-lateral",
        }),
    })),
    {
      id: "new-session",
      shortcut: shortcut("new-chat", "Mod+N"),
      title: t("sessions.page.newTitle"),
      group: "actions",
      icon: Plus,
      run: () => navigate({ to: "/sessions/new", transition: "nav-lateral" }),
    },
    {
      id: "new-bot",
      title: t("shell.command.newBot"),
      group: "actions",
      icon: Bot,
      run: () => navigate({ to: "/bots/new", transition: "nav-lateral" }),
    },
    {
      id: "theme",
      title: t("shell.command.toggleTheme"),
      group: "actions",
      icon: Moon,
      run: () =>
        updatePrefs({
          theme:
            prefs.theme === "dark"
              ? "light"
              : prefs.theme === "light"
                ? "system"
                : "dark",
        }).then(() => {}),
    },
    ...SETTINGS_PAGES.map((page): Entry => ({
      id: `settings:${page}`,
      title: t(`settings.pages.${page}`),
      group: "settings",
      icon: Settings,
      keywords: [t("shell.command.groups.settings")],
      run: () =>
        navigate({ to: `/settings/${page}`, transition: "settings-in" }),
    })),
    ...RAIL_AREAS.map((area): Entry => ({
      id: `area:${area}`,
      title: t(`shell.rail.${area}`),
      group: "navigation",
      icon: area === "bots" ? Bot : area === "sessions" ? MessageSquare : Home,
      run: () => navigate({ to: AREA_HOME[area], transition: "nav-lateral" }),
    })),
    ...(current
      ? [
          ...tabs.map((tab): Entry => ({
            id: `panel:${tab.ref}`,
            title: tab.title,
            group: "panels",
            icon: tab.ref.startsWith("terminal")
              ? Terminal
              : tab.ref.startsWith("browser")
                ? Globe
                : tab.ref === "changes"
                  ? GitCompare
                  : Folder,
            run: () =>
              navigateSession({
                to: "/sessions/$sessionId",
                params: { sessionId: current.id },
                search: (previous) => ({ ...previous, tab: tab.ref }),
                replace: true,
                transition: "none",
              }),
          })),
          ...(["files", "changes"] as const)
            .filter((kind) => !tabs.some((tab) => tab.ref === kind))
            .map((kind): Entry => ({
              id: `panel:${kind}`,
              title: t(`sessions.dock.${kind}`),
              group: "panels",
              icon: kind === "files" ? Folder : GitCompare,
              run: () =>
                navigateSession({
                  to: "/sessions/$sessionId",
                  params: { sessionId: current.id },
                  search: (previous) => ({ ...previous, tab: kind }),
                  replace: true,
                  transition: "none",
                }),
            })),
          {
            id: "expand",
            title: t("sessions.dock.full"),
            group: "panels" as const,
            icon: LayoutPanelLeft,
            run: () =>
              navigateSession({
                to: "/sessions/$sessionId",
                params: { sessionId: current.id },
                search: (previous) => ({
                  ...previous,
                  view: previous.view === "full" ? "split" : "full",
                }),
                replace: true,
                transition: "none",
              }),
          },
          {
            id: "new-terminal",
            shortcut: shortcut("new-terminal-tab", "Mod+`"),
            title: t("shell.command.newTerminal"),
            group: "panels" as const,
            icon: Terminal,
            run: () => dispatchHotkeyAction("new-terminal-tab"),
          },
        ]
      : []),
  ];
  const groups = rankCommands(entries, query);
  const loading = botsLoading || sessionsLoading || workspacesLoading;
  return (
    <Command shouldFilter={false} loop>
      <CommandInput
        placeholder={t("shell.command.placeholder")}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList aria-busy={loading}>
        {loading ? (
          <div
            role="status"
            className="text-muted-foreground px-3 py-2 text-xs"
          >
            {t("shell.command.loading")}
          </div>
        ) : null}
        {groups.length === 0 && !loading ? (
          <CommandEmpty>{t("shell.command.empty")}</CommandEmpty>
        ) : null}
        {groups.map((group) => (
          <CommandGroup
            key={group.id}
            heading={t(`shell.command.groups.${group.id}`)}
          >
            {group.entries.map((entry) => (
              <CommandItem
                key={entry.id}
                value={entry.id}
                onSelect={() => {
                  setCommandOpen(false);
                  void entry.run();
                }}
                className="h-8 py-1"
              >
                {entry.avatar ?? (
                  <entry.icon className="text-muted-foreground size-3.5" />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {highlightCommand(entry.title, query).map((part, index) =>
                    part.matched ? (
                      <mark
                        key={index}
                        className="decoration-primary/60 bg-transparent font-semibold text-inherit underline underline-offset-2"
                      >
                        {part.text}
                      </mark>
                    ) : (
                      part.text
                    )
                  )}
                </span>
                {entry.shortcut ? (
                  <CommandShortcut>
                    <Kbd>{entry.shortcut}</Kbd>
                  </CommandShortcut>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
      <div className="text-muted-foreground flex items-center gap-4 border-t px-3 py-2 text-[11px]">
        <span>
          <Kbd>↑↓</Kbd> {t("shell.command.navigate")}
        </span>
        <span>
          <Kbd>↵</Kbd> {t("shell.command.select")}
        </span>
        <span className="ml-auto">
          <Kbd>esc</Kbd> {t("shell.command.close")}
        </span>
      </div>
    </Command>
  );
};
