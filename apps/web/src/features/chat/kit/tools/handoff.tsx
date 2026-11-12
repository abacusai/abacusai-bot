/**
 * `hand_off_session`'s card: a task the agent moved into a chat of its own
 * (same folder, model and mode), running beside this one. The row shows the
 * new chat's title and its live state, and opens it.
 */
import { parsePartialJSON } from "@tanstack/ai-client";
import type { ToolProps } from "@tanstack/ai-react/ui";
import { useLiveQuery } from "@tanstack/react-db";
import { ChevronRight, GitBranch } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCollections } from "#renderer/data/db";
import { AppLink } from "#renderer/lib/navigation/app-link";

import { normalizeTool, toolInput } from "./normalize";

/** The new chat's id, as the tool's result names it (`session: <id>`). */
export const handedOffSessionId = (text: string): string | null =>
  /\bsession: ([\w-]+)/.exec(text)?.[1] ?? null;

export const HandOffCard = ({ part, result }: ToolProps<unknown>) => {
  const { t } = useTranslation();
  const collections = useCollections();
  const input = toolInput(part, parsePartialJSON);
  // No result yet reads as running: the card says Starting… until it lands.
  const tool = normalizeTool(
    part,
    result,
    {},
    { runActive: true },
    parsePartialJSON
  );
  const id = tool.status === "done" ? handedOffSessionId(tool.text) : null;
  const { data } = useLiveQuery({
    queryKey: ["handed-off", id],
    query: (q) =>
      id == null
        ? undefined
        : q.from({ s: collections.sessions }).fn.where(({ s }) => s.id === id),
  });
  const row = data?.[0];
  const title =
    row?.label.trim() ||
    (typeof input.title === "string" ? input.title.trim() : "") ||
    t("sessions.untitled");
  if (tool.status === "failed" || tool.status === "refused") return null;
  // The sidebar's dot, read off the row (the chat kit reaches no feature).
  const kind =
    row == null
      ? "starting"
      : row.turn?.phase === "waiting_permission"
        ? "needs-you"
        : row.turn?.isBusy === true
          ? "running"
          : row.turn?.phase === "error" || row.status === "error"
            ? "error"
            : "done";
  const state =
    kind === "starting"
      ? t("sessions.handoff.starting")
      : kind === "done"
        ? t("sessions.handoff.ready")
        : t(`sessions.attention.${kind}`);
  const body = (
    <>
      <GitBranch
        aria-hidden
        className="text-muted-foreground size-4 shrink-0"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{title}</span>
        <span className="text-muted-foreground text-xs">
          {t("sessions.handoff.cardLabel")}
        </span>
      </span>
      <span
        data-state={kind}
        className={
          kind === "needs-you"
            ? "shrink-0 text-xs text-[var(--bots-attention)]"
            : "text-muted-foreground shrink-0 text-xs"
        }
      >
        {kind === "running" || kind === "needs-you" ? "● " : null}
        {state}
      </span>
      <ChevronRight
        aria-hidden
        className="text-muted-foreground size-4 shrink-0"
      />
    </>
  );
  const className =
    "bg-card hover:bg-accent/50 my-2 flex w-full max-w-[520px] items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors";
  return row == null ? (
    <div data-slot="handoff-card" className={className}>
      {body}
    </div>
  ) : (
    <AppLink
      data-slot="handoff-card"
      to="/sessions/$sessionId"
      params={{ sessionId: row.id }}
      className={className}
    >
      {body}
    </AppLink>
  );
};
