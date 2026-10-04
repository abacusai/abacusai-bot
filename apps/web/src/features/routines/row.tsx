import { CalendarClock, Ellipsis } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { BotAvatar } from "#renderer/components/bot-avatar";
import { ConfirmAction } from "#renderer/components/form-kit/confirm";
import { resolveLook, type AvatarMood } from "#renderer/lib/bots/avatar";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { showError, showInfo } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "#renderer/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#renderer/ui/dropdown-menu";
import type { BotRow, RoutineRow as Row } from "@abacus-ai/contract/contract/rows";

import { routineState } from "./data";

type State = ReturnType<typeof routineState>;
const moods: Partial<Record<State, AvatarMood>> = {
  "needs-you": "waiting",
  running: "working",
  failed: "blocked",
  paused: "asleep",
};
export const RoutineIdentity = ({
  bot,
  state,
  size = 32,
}: {
  bot?: BotRow;
  state: State;
  size?: number;
}) =>
  bot ? (
    <BotAvatar
      look={resolveLook(bot)}
      mood={moods[state] ?? "idle"}
      size={size}
    />
  ) : (
    <span
      aria-hidden
      className="bg-muted text-muted-foreground flex shrink-0 items-center justify-center rounded-xl"
      style={{ width: size, height: size }}
    >
      <CalendarClock className="size-4" />
    </span>
  );
export const RoutineSidebarRow = ({
  row,
  bot,
  state,
  label,
  active,
}: {
  row: Row;
  bot?: BotRow;
  state: State;
  label: string;
  active: boolean;
}) => {
  const { t } = useTranslation();
  const { db, transport } = useAppContext();
  const navigate = useAppNavigate();
  const [deleting, setDeleting] = useState(false);
  const actions = [
    {
      label: t("phase5.runNow"),
      run: () =>
        void transport.client.routines
          .run({ id: row.id, trigger: "manual" })
          .then(() => showInfo(t("phase5.routineStarted")))
          .catch(() => showError(t("phase5.runFailed"))),
    },
    {
      label: t("phase5.edit"),
      run: () =>
        void navigate({
          to: "/routines/$routineId/edit",
          params: { routineId: row.id },
          transition: "none",
        }),
    },
    {
      label: t(row.enabled ? "phase5.pause" : "phase5.resume"),
      run: () =>
        void db.collections.routines
          .update(row.id, (d) => {
            d.enabled = !row.enabled;
          })
          .isPersisted.promise.catch(() => showError(t("phase5.failed"))),
    },
    { label: t("phase5.delete"), run: () => setDeleting(true) },
  ];
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger render={<div className="relative" />}>
          <AppLink
            to="/routines/$routineId"
            params={{ routineId: row.id }}
            aria-current={active ? "page" : undefined}
            className={`hover:bg-sidebar-accent/60 flex h-14 items-center gap-2 rounded-lg pr-9 pl-2 ${active ? "bg-sidebar-accent" : ""}`}
          >
            <span className={state === "paused" ? "opacity-60" : undefined}>
              <RoutineIdentity bot={bot} state={state} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px]">{row.name}</span>
              <span className="text-sidebar-foreground/80 block truncate text-[11px]">
                {label}
              </span>
            </span>
            <span
              aria-hidden
              data-routine-state={state}
              className={`size-1.5 shrink-0 rounded-full ${state === "failed" ? "bg-destructive" : state === "needs-you" ? "bg-attention" : state === "running" ? "bg-primary" : "bg-muted-foreground"}`}
            />
          </AppLink>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="absolute top-3 right-1"
                  aria-label={t("bots.sidebar.options", { name: row.name })}
                />
              }
            >
              <Ellipsis className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuGroup>
                {actions.map((action) => (
                  <DropdownMenuItem key={action.label} onClick={action.run}>
                    {action.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuGroup>
            {actions.map((action) => (
              <ContextMenuItem key={action.label} onClick={action.run}>
                {action.label}
              </ContextMenuItem>
            ))}
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
      <ConfirmAction
        open={deleting}
        onOpenChange={setDeleting}
        title={t("phase5.deleteRoutine")}
        description={t("phase5.deleteRoutineDescription", { name: row.name })}
        label={t("phase5.delete")}
        onConfirm={async () => {
          if (active) await navigate({ to: "/routines", replace: true });
          try {
            await db.collections.routines.delete(row.id).isPersisted.promise;
          } catch (error) {
            showError(t("phase5.failed"));
            throw error;
          }
        }}
      />
    </>
  );
};
