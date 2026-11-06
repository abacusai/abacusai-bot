/**
 * The `/` commands every chat surface shares: pages to open, and what runs on
 * the agent itself. Nothing here sends a message but `review` and `subtask`.
 */
import type {
  SessionAction,
  SessionActionResult,
} from "@abacus-ai/contract/agent-types";
import { useTranslation } from "react-i18next";

import { dispatchHotkeyAction } from "#renderer/lib/hotkeys";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { platformSystem } from "#renderer/lib/platform-system";
import { showError, showInfo } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";

import type { ComposerCommand } from "./kit/context";

const REPORT_ISSUE_URL =
  "https://github.com/abacusai/abacusai-bot/issues/new?template=bug_report.yml";

/** `target` is the running chat; a chat not started yet has no agent commands. */
export const useChatCommands = (
  target: { workspaceId: string; sessionId: string } | null
): ComposerCommand[] => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const navigate = useAppNavigate();
  const failed = (result: SessionActionResult) => {
    if (result.ok) return;
    showError(
      result.reason === "busy"
        ? t("chat.commands.busy")
        : result.reason === "not-running"
          ? t("chat.commands.notRunning")
          : result.reason === "invalid"
            ? t("chat.commands.invalid")
            : result.reason === "too-small"
              ? t("chat.commands.tooSmall")
              : t("chat.composer.commandFailed")
    );
  };
  const act = async (
    action: SessionAction,
    value: string,
    done: (result: Extract<SessionActionResult, { ok: true }>) => void
  ) => {
    if (target == null) return;
    const result = await transport.client.agent.action({
      ...target,
      action,
      ...(value !== "" ? { value } : {}),
    });
    if (result.ok) done(result);
    else failed(result);
  };
  const fullness = (percent: number | null | undefined) =>
    percent == null
      ? t("chat.commands.contextUnknown")
      : t("chat.commands.contextPercent", { percent: Math.round(percent) });
  return [
    ...(target != null
      ? [
          {
            name: "compact",
            argument: t("chat.commands.compactArgument"),
            description: t("chat.commands.compact"),
            run: (value: string) =>
              act("compact", value, () =>
                showInfo(t("chat.commands.compactDone"))
              ),
          },
          {
            name: "context",
            description: t("chat.commands.context"),
            run: () =>
              act("context", "", ({ percent }) => showInfo(fullness(percent))),
          },
          {
            name: "effort",
            argument: t("chat.commands.effortArgument"),
            description: t("chat.commands.effort"),
            run: (value: string) =>
              act("effort", value, ({ level }) =>
                showInfo(t("chat.commands.effortDone", { level }))
              ),
          },
          {
            name: "autocompact",
            argument: t("chat.commands.autocompactArgument"),
            valueRequired: true,
            description: t("chat.commands.autocompact"),
            run: (value: string) =>
              act("autocompact", value, () =>
                showInfo(t("chat.commands.autocompactDone", { value }))
              ),
          },
          {
            name: "export",
            description: t("chat.commands.export"),
            run: () =>
              act("export", "", ({ path }) =>
                showInfo(t("chat.commands.exportDone"), { description: path })
              ),
          },
          {
            name: "tasks",
            description: t("chat.commands.tasks"),
            run: () =>
              act("tasks", "", ({ live }) =>
                showInfo(t("chat.commands.tasksDone", { count: live ?? 0 }))
              ),
          },
          {
            name: "status",
            description: t("chat.commands.status"),
            run: () =>
              act("context", "", ({ percent }) =>
                showInfo(t("chat.commands.statusDone"), {
                  description: fullness(percent),
                })
              ),
          },
          {
            name: "review",
            aliases: ["ultrareview"],
            argument: t("chat.commands.reviewArgument"),
            description: t("chat.commands.review"),
            expand: (value: string) =>
              t("chat.commands.reviewPrompt", { value }).trim(),
          },
          {
            name: "subtask",
            argument: t("chat.commands.subtaskArgument"),
            valueRequired: true,
            description: t("chat.commands.subtask"),
            expand: (value: string) =>
              t("chat.commands.subtaskPrompt", { value }),
          },
        ]
      : []),
    {
      name: "resume",
      description: t("chat.commands.resume"),
      run: () => dispatchHotkeyAction("command-menu"),
    },
    {
      name: "usage",
      aliases: ["cost", "usage-credits"],
      description: t("chat.commands.usage"),
      run: () => navigate({ to: "/settings/usage" }),
    },
    {
      name: "config",
      description: t("chat.commands.config"),
      run: () => navigate({ to: "/settings/general" }),
    },
    {
      name: "theme",
      description: t("chat.commands.theme"),
      run: () => navigate({ to: "/settings/appearance" }),
    },
    {
      name: "login",
      description: t("chat.commands.login"),
      run: () => navigate({ to: "/settings/account" }),
    },
    {
      name: "memory",
      description: t("chat.commands.memory"),
      run: () => navigate({ to: "/settings/memory" }),
    },
    {
      name: "connectors",
      description: t("chat.commands.connectors"),
      run: () => navigate({ to: "/library/connectors" }),
    },
    {
      name: "skills",
      description: t("chat.commands.skills"),
      run: () => navigate({ to: "/library/skills" }),
    },
    {
      name: "mcp",
      description: t("chat.commands.mcp"),
      run: () => navigate({ to: "/library/mcp" }),
    },
    {
      name: "plugin",
      description: t("chat.commands.plugin"),
      run: () => navigate({ to: "/library/tools" }),
    },
    {
      name: "workflows",
      description: t("chat.commands.workflows"),
      run: () => navigate({ to: "/routines" }),
    },
    {
      name: "agents",
      description: t("chat.commands.agents"),
      run: () => navigate({ to: "/bots/new" }),
    },
    {
      name: "feedback",
      description: t("chat.commands.feedback"),
      run: () =>
        platformSystem(transport.client).openExternal({
          url: REPORT_ISSUE_URL,
        }),
    },
  ];
};
