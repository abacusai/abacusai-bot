import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { useRouter } from "@tanstack/react-router";
import { Terminal } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useSession } from "#renderer/features/sessions/data/queries";
import {
  closeTerminal,
  TerminalTab,
} from "#renderer/features/sessions/terminal/terminal-tab";
import {
  dispatchAppHotkey,
  useAppHotkey,
} from "#renderer/features/shell/hotkeys";
import {
  activatePanelTab,
  closePanelTab,
  openPanelTab,
} from "#renderer/features/shell/panel-store";
import { SidePanelContent } from "#renderer/features/shell/side-panel-slot";
import { TopBar } from "#renderer/features/shell/top-bar";
import { useTopBarEndActions } from "#renderer/features/shell/top-bar-slots";
import { activeTabOf, usePanelScope } from "#renderer/features/shell/use-panel";

/**
 * Terminals in a bot's chat, in the bot's own panel and folder. They belong
 * to the bot (its main chat's session), as the panel does, so the same
 * shells are there in each of its chats.
 */
export const BotTerminals = ({
  botSessionId,
  panelKey,
}: {
  botSessionId: string;
  panelKey: string;
}) => {
  const { t } = useTranslation();
  const transport = useRouter().options.context.transport;
  const row = useSession(botSessionId);
  const panel = usePanelScope(panelKey);
  const terminals = panel.tabs.filter((tab) => tab.kind === "terminal");
  const active = activeTabOf(panel);
  const shown = panel.open && active?.kind === "terminal";
  const key = row ? sessionConversationKey(row.workspaceId, row.id) : null;
  const open = () => {
    const base = t("sessions.dock.terminal");
    const used = new Set(terminals.map((tab) => tab.title));
    let n = 1;
    while (used.has(n === 1 ? base : `${base} ${n}`)) n++;
    openPanelTab(
      panelKey,
      { kind: "terminal", title: n === 1 ? base : `${base} ${n}` },
      { fresh: true }
    );
  };
  // The icon brings up the latest terminal, or a first one; Ctrl+` always
  // opens another, as in a chat.
  const show = () => {
    const latest = terminals.at(-1);
    if (latest) activatePanelTab(panelKey, latest.id);
    else open();
  };
  useAppHotkey("Mod+`", open, {
    actionId: "new-terminal-tab",
    enabled: key != null,
  });
  useTopBarEndActions(
    key == null
      ? []
      : [
          {
            id: "panel-shortcut:terminal",
            label: t("sessions.dock.terminal"),
            icon: <Terminal />,
            onSelect: show,
            render: (
              <TopBar.IconButton
                label={t("sessions.dock.terminal")}
                aria-pressed={shown}
                data-active={shown ? "" : undefined}
                data-slot="panel-shortcut"
                className="data-active:bg-sidebar-accent data-active:text-sidebar-foreground"
                onClick={show}
              >
                <Terminal />
              </TopBar.IconButton>
            ),
          },
        ]
  );
  // A terminal tab closed in the panel ends its shell; leaving the chat
  // (the route unmounting) does not.
  const known = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(terminals.map((tab) => tab.id));
    if (key)
      for (const id of known.current)
        if (!now.has(id)) {
          closeTerminal(transport, key, id.slice("terminal:".length));
        }
    known.current = now;
  });
  if (!row) return null;
  return (
    <SidePanelContent kind="terminal">
      {(tab, visible) => (
        <TerminalTab
          row={{ workspaceId: row.workspaceId, id: row.id }}
          id={tab.id.slice("terminal:".length)}
          visible={visible}
          onClose={() => closePanelTab(panelKey, tab.id)}
          dispatch={dispatchAppHotkey}
          onUrl={(url) =>
            openPanelTab(panelKey, { kind: "browser", url }, { fresh: true })
          }
        />
      )}
    </SidePanelContent>
  );
};
