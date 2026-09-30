import { useParams, useSearch } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "#next/components/empty-state";
import { ConfirmAction } from "#next/components/form-kit/confirm";
import { AppLink } from "#next/lib/navigation/app-link";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { showInfo, showError } from "#next/lib/toast";
import { useAppContext, rpcError, errorText } from "#next/lib/use-app-context";
import { Button } from "#next/ui/button";
import { Input } from "#next/ui/input";
import { Switch } from "#next/ui/switch";

import { runsView, scheduleLabel, useRoutinesData } from "./data";
export const RoutinesListBody = () => {
  const { t } = useTranslation();
  const { routines } = useRoutinesData();
  return (
    <div
      className="flex size-full items-center justify-center"
      data-testid="routines-list-body"
    >
      <EmptyState
        icon="routines"
        title={t(
          routines.length ? "phase5.pickRoutine" : "routines.page.emptyTitle"
        )}
        description={t("routines.page.emptyDescription")}
        action={
          <Button
            nativeButton={false}
            render={<AppLink to="/routines/new" transition="none" />}
          >
            {t("routines.sidebar.new")}
          </Button>
        }
      />
    </div>
  );
};

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
export const RunReportFrame = ({
  runId,
  children,
  onClose,
}: {
  runId: string;
  children?: ReactNode;
  onClose(): void;
}) => {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t("phase5.runReport")}
      className="[&_.min-h-13>span]:text-foreground flex h-full flex-col"
    >
      <header className="flex h-11 items-center justify-between gap-2 border-b px-4">
        <span>{t("phase5.runReport")}</span>
        <AppLink to="/sessions/$sessionId" params={{ sessionId: runId }}>
          {t("phase5.openSession")}
        </AppLink>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("phase5.closeRun")}
          onClick={onClose}
        >
          {t("phase5.close")}
        </Button>
      </header>
      <p className="text-muted-foreground px-4 py-2 text-xs">
        {t("phase5.readOnlyRun")}
      </p>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
};
export const RoutinePage = ({
  renderRunReport,
}: {
  renderRunReport?: (runId: string) => ReactNode;
}) => {
  const { t, i18n } = useTranslation();
  const { db, transport } = useAppContext();
  const { routineId } = useParams({ strict: false }) as { routineId: string };
  const { run } = useSearch({ strict: false }) as { run?: string };
  const navigate = useAppNavigate();
  const { routines, runs, workspaces } = useRoutinesData();
  const row = routines.find((r) => r.id === routineId);
  const [limit, setLimit] = useState(50);
  if (!row) return <RoutineGone />;
  const attempts = runsView(row, runs);
  const clear = () =>
    void navigate({
      search: (p) => ({ ...p, run: undefined }),
      transition: "none",
    });
  const runNow = () =>
    void transport.client.routines
      .run({ id: row.id, trigger: "manual" })
      .then(() => showInfo(t("phase5.routineStarted")))
      .catch(() => showError(t("phase5.runFailed")));
  return (
    <div className="flex size-full min-w-0">
      <div
        className={
          run
            ? "hidden min-w-0 flex-1 overflow-auto xl:block"
            : "min-w-0 flex-1 overflow-auto"
        }
      >
        <div className="flex flex-col gap-5 p-6">
          <header className="flex flex-wrap items-center gap-3">
            <div className="mr-auto">
              <h1 className="text-lg font-semibold">{row.name}</h1>
              <p className="text-muted-foreground text-xs">
                {scheduleLabel(row, t, i18n.language)} ·{" "}
                {workspaces.find((w) => w.id === row.workspaceId)?.label ??
                  t("phase5.ownFolder")}
                {row.botName &&
                  ` · ${t("phase5.madeBy", { name: row.botName })}`}
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={runNow}>
              {t("phase5.runNow")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              nativeButton={false}
              render={
                <AppLink
                  to="/routines/$routineId/edit"
                  params={{ routineId: row.id }}
                  search={{ run }}
                  transition="none"
                />
              }
            >
              {t("phase5.edit")}
            </Button>
            <Switch
              aria-label={t("phase5.routineOn")}
              checked={row.enabled}
              onCheckedChange={(enabled) =>
                void db.collections.routines
                  .update(row.id, (d) => {
                    d.enabled = enabled;
                  })
                  .isPersisted.promise.catch(() =>
                    showError(t("phase5.failed"))
                  )
              }
            />
            <ConfirmAction
              title={t("phase5.deleteRoutine")}
              description={t("phase5.deleteRoutineDescription", {
                name: row.name,
              })}
              label={t("phase5.delete")}
              onConfirm={async () => {
                await navigate({ to: "/routines", replace: true });
                await db.collections.routines.delete(row.id).isPersisted
                  .promise;
              }}
            />
          </header>
          <div className="grid grid-cols-3 gap-2">
            {[
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
            ].map(([label, value]) => (
              <div key={label} className="bg-card rounded-xl p-3">
                <div className="text-muted-foreground text-xs">{label}</div>
                <div className="mt-1 text-sm">{value}</div>
              </div>
            ))}
          </div>
          {row.webhookUrl && (
            <div className="flex items-center gap-2">
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
          <section>
            <h2 className="text-muted-foreground mb-2 text-xs">
              {t("phase5.instruction")}
            </h2>
            <div className="bg-card rounded-xl p-4 text-[13px] whitespace-pre-wrap">
              {row.prompt}
            </div>
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold">{t("phase5.runs")}</h2>
            <p className="text-muted-foreground mb-2 text-xs">
              {t("phase5.freshSession")}
            </p>
            <div className="flex flex-col gap-1">
              {attempts.slice(0, limit).map((a) => {
                const content = (
                  <>
                    <span className="w-20 shrink-0">
                      {t(`phase5.outcomes.${a.outcome}`)}
                    </span>
                    <time className="w-28 shrink-0 text-xs">
                      {new Date(a.at).toLocaleString(i18n.language, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </time>
                    <span className="min-w-0 flex-1 truncate">{a.result}</span>
                    <span className="text-muted-foreground text-xs">
                      {a.trigger}
                    </span>
                  </>
                );
                return a.sessionId && !a.note ? (
                  <Button
                    key={a.id}
                    variant={run === a.sessionId ? "secondary" : "ghost"}
                    className="h-12 justify-start"
                    aria-pressed={run === a.sessionId}
                    onClick={() =>
                      void navigate({
                        search: (p) => ({
                          ...p,
                          run: run === a.sessionId ? undefined : a.sessionId!,
                        }),
                        transition: "none",
                      })
                    }
                  >
                    {content}
                  </Button>
                ) : (
                  <div
                    key={a.id}
                    className="text-muted-foreground flex min-h-12 items-center gap-3 px-2 text-xs"
                  >
                    {content}
                  </div>
                );
              })}
            </div>
            {attempts.length === 0 && (
              <p className="text-muted-foreground text-xs">
                {t("phase5.noRuns")}
              </p>
            )}
            {attempts.length > limit && (
              <Button variant="ghost" onClick={() => setLimit(limit + 50)}>
                {t("phase5.showMore")}
              </Button>
            )}
          </section>
          <EditorChat key={row.id} routineId={row.id} />
        </div>
      </div>
      {run && (
        <aside className="h-full min-w-0 flex-1 border-l xl:w-[420px] xl:flex-none">
          <RunReportFrame runId={run} onClose={clear}>
            {runs.some((r) => r.sessionId === run) ? (
              renderRunReport?.(run)
            ) : (
              <p role="status">{t("phase5.runGone")}</p>
            )}
          </RunReportFrame>
        </aside>
      )}
    </div>
  );
};
type Exchange = { user: string; reply: string };
const readLog = (id: string): Exchange[] => {
  try {
    return JSON.parse(
      sessionStorage.getItem(`routine-editor:${id}`) ?? "[]"
    ) as Exchange[];
  } catch {
    return [];
  }
};
export const EditorChat = ({ routineId }: { routineId: string }) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState(() => readLog(routineId));
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
      const next = [...log, { user, reply: result.reply }].slice(-10);
      setLog(next);
      sessionStorage.setItem(
        `routine-editor:${routineId}`,
        JSON.stringify(next)
      );
      setText("");
    } catch (e) {
      if (rpcError(e)?.code === "NOT_FOUND") setGone(true);
      const reply =
        rpcError(e)?.code === "TIMEOUT"
          ? t("phase5.editTimeout")
          : `${t("phase5.editFailed")} ${errorText(e)}`;
      const next = [...log, { user, reply }].slice(-10);
      setLog(next);
      sessionStorage.setItem(
        `routine-editor:${routineId}`,
        JSON.stringify(next)
      );
    }
    setBusy(false);
  };
  if (gone) return <RoutineGone />;
  return (
    <section className="bg-card flex flex-col gap-3 rounded-xl p-4">
      <h2 className="text-sm font-medium">{t("phase5.editByChat")}</h2>
      {log.map((x, i) => (
        <div key={i} className="flex flex-col gap-2 text-xs">
          <p className="bg-muted self-end rounded-xl px-3 py-2">{x.user}</p>
          <p>{x.reply}</p>
        </div>
      ))}
      <div aria-live="polite">
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
