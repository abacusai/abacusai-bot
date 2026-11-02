import { useParams, useSearch } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import {
  CheckCircle2,
  ChevronLeft,
  CircleAlert,
  CirclePlay,
  CircleStop,
  Loader2,
  Pause,
  Pencil,
  Play,
  SquareArrowOutUpRight,
  Trash2,
  WifiOff,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "#renderer/components/empty-state";
import { ConfirmAction } from "#renderer/components/form-kit/confirm";
import { isRpcError } from "#renderer/data/query-client";
import { persistedStore } from "#renderer/lib/continuity/registry";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { showInfo, showError } from "#renderer/lib/toast";
import { useAppContext, errorText } from "#renderer/lib/use-app-context";
import { useMediaQuery } from "#renderer/lib/use-media-query";
import { Button } from "#renderer/ui/button";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "#renderer/ui/collapsible";
import { Input } from "#renderer/ui/input";

import { MissedRunsNote } from "./always-on";
import {
  runsView,
  scheduleLabel,
  routineState,
  useRoutinesData,
  type RunView,
} from "./data";
import { isHosted } from "./hosted";
import { HostedResults } from "./hosted-results";
import { runRoutineNow, showSaveFailure, useHostedOff } from "./hosted-sync";
import { RoutinesLanding } from "./landing";
import { RoutinePausedReason, RoutineReachPanel } from "./reach-panel";
import { RoutineIdentity } from "./row";
/** No routine open: the way to make one, with the templates (landing.tsx). */
export const RoutinesListBody = RoutinesLanding;

export const RoutineGone = () => {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon="routines"
      title={t("phase5.routineGone")}
      action={<AppLink to="/routines">{t("phase5.allRoutines")}</AppLink>}
    />
  );
};
const RUN_GROUPS = ["running", "completed", "failed"] as const;
/** Every fire of a routine, newest first, grouped so a running one is never buried. */
const RunsRail = ({
  attempts,
  openable,
  selected,
  onSelect,
}: {
  attempts: RunView[];
  openable: readonly RunView[];
  selected: string | undefined;
  onSelect(sessionId: string): void;
}) => {
  const { t, i18n } = useTranslation();
  const [limit, setLimit] = useState(50);
  const shown = attempts.slice(0, limit);
  const groups = [
    ...RUN_GROUPS.map((outcome) => ({
      outcome,
      items: shown.filter((a) => a.outcome === outcome),
    })),
    {
      outcome: "other",
      items: shown.filter(
        (a) => !(RUN_GROUPS as readonly string[]).includes(a.outcome)
      ),
    },
  ];
  return (
    <section aria-label={t("phase5.runs")} className="flex flex-col gap-3">
      <h2 className="flex items-baseline justify-between text-sm font-semibold">
        {t("phase5.runs")}
        <span className="text-muted-foreground text-xs font-normal tabular-nums">
          {attempts.length}
        </span>
      </h2>
      {attempts.length === 0 && (
        <p className="text-muted-foreground text-xs">
          {t("routines.noRunsYet")}
        </p>
      )}
      {groups.map(({ outcome, items }) =>
        items.length === 0 ? null : (
          <div key={outcome} className="flex flex-col gap-1">
            {outcome !== "other" && (
              <h3 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                {t(`phase5.outcomes.${outcome}`)}
              </h3>
            )}
            {items.map((a) => {
              const content = (
                <>
                  {a.outcome === "running" ? (
                    <Loader2 className="text-primary size-3.5 shrink-0 animate-spin" />
                  ) : a.outcome === "failed" ? (
                    <CircleAlert className="text-destructive size-3.5 shrink-0" />
                  ) : a.outcome === "offline" ||
                    a.outcome === "skipped-offline" ? (
                    // The network's doing, not the routine's: no red.
                    <WifiOff className="text-muted-foreground size-3.5 shrink-0" />
                  ) : a.outcome === "interrupted" ? (
                    // The app closed under it: not the routine's doing either.
                    <CircleStop className="text-muted-foreground size-3.5 shrink-0" />
                  ) : (
                    <CheckCircle2 className="text-muted-foreground size-3.5 shrink-0" />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <time className="truncate">
                      {new Date(a.at).toLocaleString(i18n.language, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </time>
                    <span className="text-muted-foreground truncate">
                      {t(`phase5.outcomes.${a.outcome}`)} ·{" "}
                      {t(
                        [
                          "manual",
                          "create",
                          "schedule",
                          "catch-up",
                          "interrupted",
                          "webhook",
                          "agent",
                        ].includes(a.trigger)
                          ? `routines.triggers.${a.trigger}`
                          : "routines.triggers.schedule"
                      )}
                    </span>
                  </span>
                </>
              );
              return openable.includes(a) ? (
                <Button
                  key={a.id}
                  variant={selected === a.sessionId ? "secondary" : "ghost"}
                  className="h-auto min-w-0 justify-start gap-2 px-2 py-1.5 text-left text-xs font-normal whitespace-normal"
                  aria-pressed={selected === a.sessionId}
                  onClick={() => onSelect(a.sessionId!)}
                >
                  {content}
                </Button>
              ) : (
                <div
                  key={a.id}
                  className="text-muted-foreground flex items-center gap-2 px-2 py-1.5 text-xs"
                >
                  {content}
                </div>
              );
            })}
          </div>
        )
      )}
      {attempts.length > limit && (
        <Button variant="ghost" size="sm" onClick={() => setLimit(limit + 50)}>
          {t("phase5.showMore")}
        </Button>
      )}
    </section>
  );
};
/**
 * A routine's page: the selected run's report in the pane (the newest until
 * one is picked), the routine's facts and every run in the rail, and the
 * editor along the bottom. Narrow, the rail is the page until a run opens.
 */
export interface RoutineAction {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect(): void;
}
export const RoutinePage = ({
  renderTitle,
  renderRunReport,
  renderRequests,
}: {
  /** The routine's identity and actions, for the title bar. */
  renderTitle?: (title: {
    identity: ReactNode;
    actions: RoutineAction[];
  }) => ReactNode;
  renderRunReport?: (runId: string) => ReactNode;
  /** The connector asks of these runs (the open run's are in its report). */
  renderRequests?: (sessionIds: ReadonlySet<string>) => ReactNode;
}) => {
  const { t, i18n } = useTranslation();
  const { db, transport } = useAppContext();
  const { routineId } = useParams({ strict: false }) as { routineId: string };
  const { run } = useSearch({ strict: false }) as { run?: string };
  const navigate = useAppNavigate();
  const wide = useMediaQuery("(min-width: 1100px)");
  const { routines, runs, workspaces, sessions, bots } = useRoutinesData();
  const row = routines.find((r) => r.id === routineId);
  const hostedOff = useHostedOff();
  const [deleting, setDeleting] = useState(false);
  if (!row) return <RoutineGone />;
  const state = routineState(row, runs, sessions, undefined, hostedOff);
  const subtitle = [
    scheduleLabel(row, t, i18n.language),
    isHosted(row)
      ? // An event routine has no time, so no zone to name.
        row.hosted?.timezone != null &&
        (row.schedule != null || row.runAt != null)
        ? t("routines.hosted.info", { zone: row.hosted.timezone })
        : t("routines.hosted.badge")
      : (workspaces.find(
          (w) =>
            w.id === row.workspaceId && w.kind !== "routine" && w.kind !== "bot"
        )?.label ?? t("phase5.ownFolder")),
    ...(row.botName ? [t("phase5.madeBy", { name: row.botName })] : []),
  ].join(" · ");
  const hosted = isHosted(row);
  const attempts = runsView(row, runs);
  // Only a run whose session is still here has a report to open.
  const openable = attempts.filter(
    (a) => !a.note && runs.some((r) => r.sessionId === a.sessionId)
  );
  // The picked run while it exists; wide, else the newest.
  const selected =
    openable.find((a) => a.sessionId === run)?.sessionId ??
    (wide ? (openable[0]?.sessionId ?? undefined) : undefined);
  const pick = (sessionId: string | undefined) =>
    void navigate({
      search: (p) => ({ ...p, run: sessionId }),
      transition: "none",
    });
  const runNow = () => runRoutineNow(row, transport, t);
  const showReport = !hosted && selected != null;
  const facts = [
    [
      t("phase5.nextLabel"),
      row.nextRunAt
        ? new Date(row.nextRunAt).toLocaleString(i18n.language)
        : "—",
    ],
    [
      t("phase5.last"),
      row.lastRunAt
        ? new Date(row.lastRunAt).toLocaleString(i18n.language)
        : t("phase5.never"),
    ],
    [
      t("phase5.trigger"),
      row.webhookToken
        ? t("phase5.webhook")
        : scheduleLabel(row, t, i18n.language),
    ],
  ];
  const longPrompt =
    row.prompt.length > 240 || row.prompt.split("\n").length > 4;
  const rail = (
    <aside className="flex min-h-0 min-w-0 flex-col gap-5 overflow-y-auto p-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="[overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      {!hosted && <RoutinePausedReason row={row} />}
      {!hosted && row.missed != null && <MissedRunsNote missed={row.missed} />}
      {row.webhookUrl && (
        <div className="flex items-center gap-2 text-xs">
          <code className="min-w-0 truncate">{row.webhookUrl}</code>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void navigator.clipboard
                .writeText(row.webhookUrl!)
                .then(() => showInfo(t("phase5.copied")))
                .catch(() => showError(t("phase5.failed")))
            }
          >
            {t("phase5.copy")}
          </Button>
        </div>
      )}
      {row.webhookPublicPending && (
        <p className="text-muted-foreground text-xs">
          {t("routines.webhookPublicPending")}
        </p>
      )}
      <section>
        <h2 className="text-muted-foreground mb-2 text-xs">
          {t("phase5.instruction")}
        </h2>
        <Collapsible className="bg-card group/instruction rounded-xl p-3 text-[13px]">
          <div
            className={`${longPrompt ? "line-clamp-4" : ""} [overflow-wrap:anywhere] whitespace-pre-wrap group-data-[open]/instruction:hidden`}
          >
            {row.prompt}
          </div>
          <CollapsibleContent className="[overflow-wrap:anywhere] whitespace-pre-wrap">
            {row.prompt}
          </CollapsibleContent>
          {longPrompt && (
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
              <span className="group-data-[open]/instruction:hidden">
                {t("chat.permission.showAll")}
              </span>
              <span className="hidden group-data-[open]/instruction:inline">
                {t("chat.code.showLess")}
              </span>
            </CollapsibleTrigger>
          )}
        </Collapsible>
      </section>
      <RoutineReachPanel row={row} />
      {!hosted && (
        <RunsRail
          attempts={attempts}
          openable={openable}
          selected={selected}
          onSelect={pick}
        />
      )}
    </aside>
  );
  return (
    <div className="flex size-full min-h-0 min-w-0 flex-col">
      <h1 className="sr-only">{row.name}</h1>
      {renderTitle?.({
        identity: (
          <span className="flex min-w-0 items-center gap-2 text-[13px]">
            <RoutineIdentity
              bot={bots.find((b) => b.id === row.botId)}
              state={state}
              size={22}
            />
            <span className="text-sidebar-foreground min-w-0 truncate font-medium">
              {row.name}
            </span>
            <span className="text-muted-foreground min-w-0 truncate text-xs">
              {state === "scheduled"
                ? subtitle
                : `${t(`phase5.states.${state}`)} · ${subtitle}`}
            </span>
          </span>
        ),
        actions: [
          ...(showReport
            ? [
                {
                  id: "open-session",
                  label: t("phase5.openSession"),
                  icon: <SquareArrowOutUpRight />,
                  onSelect: () =>
                    void navigate({
                      to: "/sessions/$sessionId",
                      params: { sessionId: selected },
                    }),
                },
              ]
            : []),
          {
            id: "run-now",
            label: t("phase5.runNow"),
            icon: <Play />,
            onSelect: runNow,
          },
          {
            id: "toggle",
            label: t(row.enabled ? "phase5.pause" : "phase5.resume"),
            icon: row.enabled ? <Pause /> : <CirclePlay />,
            onSelect: () =>
              void db.collections.routines
                .update(row.id, (d) => {
                  d.enabled = !row.enabled;
                })
                .isPersisted.promise.catch((error: unknown) =>
                  showSaveFailure(error, transport, t)
                ),
          },
          {
            id: "edit",
            label: t("phase5.edit"),
            icon: <Pencil />,
            onSelect: () =>
              void navigate({
                to: "/routines/$routineId/edit",
                params: { routineId: row.id },
                search: { run },
                transition: "none",
              }),
          },
          {
            id: "delete",
            label: t("phase5.delete"),
            icon: <Trash2 />,
            onSelect: () => setDeleting(true),
          },
        ],
      })}
      <ConfirmAction
        open={deleting}
        onOpenChange={setDeleting}
        title={t("phase5.deleteRoutine")}
        description={t("phase5.deleteRoutineDescription", { name: row.name })}
        label={t("phase5.delete")}
        onConfirm={async () => {
          await navigate({ to: "/routines", replace: true });
          try {
            await db.collections.routines.delete(row.id).isPersisted.promise;
          } catch (error) {
            showError(t("phase5.failed"));
            throw error;
          }
        }}
      />
      {!wide && selected != null && (
        <div className="border-b px-2 py-1.5">
          <Button size="sm" variant="ghost" onClick={() => pick(undefined)}>
            <ChevronLeft />
            {t("phase5.runs")}
          </Button>
        </div>
      )}
      {hosted && hostedOff && (
        <p role="status" className="text-muted-foreground px-4 pt-3 text-xs">
          {t("routines.hosted.unavailable")}
        </p>
      )}
      {!hosted &&
        renderRequests?.(
          new Set(
            sessions
              .filter((s) => s.routineId === row.id && s.id !== selected)
              .map((s) => s.id)
          )
        )}
      {hosted && !wide ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rail}
          <div className="px-4 pb-4">
            <HostedResults row={row} />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {(wide || selected != null) && (
            <main className="flex min-h-0 min-w-0 flex-1 flex-col">
              {hosted ? (
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <HostedResults row={row} />
                </div>
              ) : selected != null ? (
                <div className="min-h-0 flex-1">
                  {renderRunReport?.(selected)}
                </div>
              ) : (
                <div className="flex flex-1 items-center justify-center p-6">
                  <EmptyState
                    icon="routines"
                    title={t("routines.noRunsYet")}
                    action={
                      <Button variant="secondary" onClick={runNow}>
                        {t("phase5.runNow")}
                      </Button>
                    }
                  />
                </div>
              )}
            </main>
          )}
          {(wide || selected == null) && (
            <div
              className={
                wide
                  ? "flex w-72 shrink-0 flex-col border-s"
                  : "flex min-w-0 flex-1 flex-col"
              }
            >
              {rail}
            </div>
          )}
        </div>
      )}
      {!hosted && <EditorChat key={row.id} routineId={row.id} />}
    </div>
  );
};
type Exchange = { user: string; reply: string };
export const EditorChat = ({ routineId }: { routineId: string }) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // The last ten exchanges, read back when the editor mounts. Registered
  // for continuity while mounted, from the effect: a discarded render
  // never binds, and an unmounted editor is not captured.
  const [store] = useState(() =>
    persistedStore<Exchange[]>(
      `abacusai-bot:routine-editor:${routineId}`,
      () => [],
      { bind: false }
    )
  );
  useEffect(() => store.bind(), [store]);
  const log = useSelector(store, (state) => state);
  const [gone, setGone] = useState(false);
  const send = async () => {
    const user = text.trim();
    if (!user || busy) return;
    setBusy(true);
    try {
      const result = await transport.client.routines.editByChat({
        routineId,
        text: user,
      });
      store.setState((log) =>
        [...log, { user, reply: result.reply }].slice(-10)
      );
      setText("");
    } catch (e) {
      const code = isRpcError(e) ? e.code : null;
      if (code === "NOT_FOUND") setGone(true);
      const reply =
        code === "TIMEOUT"
          ? t("phase5.editTimeout")
          : `${t("phase5.editFailed")} ${errorText(e)}`;
      store.setState((log) => [...log, { user, reply }].slice(-10));
    }
    setBusy(false);
  };
  if (gone) return <RoutineGone />;
  return (
    <section
      aria-label={t("phase5.editByChat")}
      className="flex flex-col gap-2 border-t px-4 py-3"
    >
      {log.length > 0 && (
        <div className="flex max-h-32 flex-col gap-2 overflow-y-auto">
          {log.map((x, i) => (
            <div key={i} className="flex flex-col gap-1 text-xs">
              <p className="bg-muted self-end rounded-xl px-3 py-2">{x.user}</p>
              <p>{x.reply}</p>
            </div>
          ))}
        </div>
      )}
      <div
        aria-live="polite"
        className="text-muted-foreground text-xs empty:hidden"
      >
        {busy ? t("phase5.changing") : log.at(-1)?.reply}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Input
          aria-label={t("phase5.editInstruction")}
          placeholder={t("phase5.editInstruction")}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
        />
        <Button disabled={busy || !text.trim()} type="submit">
          {t("phase5.send")}
        </Button>
      </form>
    </section>
  );
};
