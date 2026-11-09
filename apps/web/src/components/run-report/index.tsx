/**
 * A routine run's report as the app delivered it into a chat (the run
 * session's `report` stamp, flag `routine-delivery`): a card in the
 * transcript at the time it arrived, the run's final answer word for word,
 * with a link to the full run. Drawn by wrapping the route's
 * `decorateMessage`; the types are the chat kit's, declared structurally.
 */
import type { UIMessage } from "@tanstack/ai-client";
import { useLiveQuery } from "@tanstack/react-db";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useCollections } from "#renderer/data/db";
import { messageTime } from "#renderer/lib/bot-turns/gap-stamp";
import { isCheckInRoutine } from "#renderer/lib/bots/check-in";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { hiddenUserMessage } from "#renderer/lib/user-message";

export interface RunReportView {
  runSessionId: string;
  routineId: string;
  /** The routine's name; null for a bot's check-in. */
  routineName: string | null;
  at: Date;
  text: string;
}

/** The reports delivered into `sessionId`, oldest first. */
export const useRunReports = (sessionId: string | null): RunReportView[] => {
  const collections = useCollections();
  const { data: runs } = useLiveQuery({
    queryKey: ["run-reports", sessionId],
    query: (q) =>
      sessionId == null
        ? undefined
        : q
            .from({ s: collections.sessions })
            .fn.where(({ s }) => s.report?.to === sessionId),
  });
  const { data: routines } = useLiveQuery((q) =>
    q.from({ r: collections.routines })
  );
  return (runs ?? [])
    .flatMap((run) => {
      if (run.report == null || run.routineId == null) return [];
      const routine = (routines ?? []).find((row) => row.id === run.routineId);
      const checkIn =
        routine?.botId != null && isCheckInRoutine(routine, routine.botId);
      return [
        {
          runSessionId: run.id,
          routineId: run.routineId,
          routineName: checkIn ? null : (routine?.name ?? null),
          at: new Date(run.report.at),
          text: run.report.text,
        },
      ];
    })
    .toSorted((a, b) => a.at.getTime() - b.at.getTime());
};

export const RunReportCard = ({ report }: { report: RunReportView }) => {
  const { t, i18n } = useTranslation();
  const time = report.at.toLocaleTimeString(i18n.language, {
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <div
      className="bg-muted/40 mx-auto my-2 flex w-full max-w-[min(640px,90%)] flex-col gap-2 rounded-xl border p-3 text-sm"
      data-slot="run-report"
      data-run={report.runSessionId}
    >
      <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
        <span className="truncate font-medium">
          {report.routineName == null
            ? t("routines.report.checkIn", { time })
            : t("routines.report.title", { name: report.routineName, time })}
        </span>
        <AppLink
          to="/routines/$routineId"
          params={{ routineId: report.routineId }}
          search={{ run: report.runSessionId }}
          className="shrink-0 underline"
        >
          {t("routines.report.openRun")}
        </AppLink>
      </div>
      <div className="[overflow-wrap:anywhere] whitespace-pre-wrap">
        {report.text}
      </div>
    </div>
  );
};

export interface DecorationContext {
  messages: readonly UIMessage[];
  index: number;
  runActive: boolean;
}

export interface Decoration {
  hidden?: boolean;
  before?: ReactNode;
  after?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
}

export type Decorate = (
  message: UIMessage,
  context: DecorationContext
) => Decoration | null;

/**
 * Each report's place: after the last shown message at or before the time it
 * arrived, or before the first shown message when it came before all of them.
 */
export const reportAnchors = <Report extends { at: Date }>(
  messages: readonly UIMessage[],
  reports: readonly Report[],
  shown: (index: number) => boolean
): Map<number, { before: Report[]; after: Report[] }> => {
  const anchors = new Map<number, { before: Report[]; after: Report[] }>();
  const slot = (index: number) => {
    const entry = anchors.get(index) ?? { before: [], after: [] };
    anchors.set(index, entry);
    return entry;
  };
  const visible = messages.flatMap((_, index) => (shown(index) ? [index] : []));
  if (visible.length === 0) return anchors;
  for (const report of reports) {
    let anchor: number | null = null;
    for (const index of visible) {
      const at = messageTime(messages[index]!);
      if (at != null && at.getTime() > report.at.getTime()) break;
      anchor = index;
    }
    if (anchor == null) slot(visible[0]!).before.push(report);
    else slot(anchor).after.push(report);
  }
  return anchors;
};

/** The last stored message a shown row covers (a session row folds several). */
const rowEnd = (messages: readonly UIMessage[], host: number): number => {
  let end = host;
  for (const id of (
    messages[host]!.metadata as
      | { abacus?: { coalescedIds?: string[] } }
      | undefined
  )?.abacus?.coalescedIds ?? [])
    end = Math.max(
      end,
      messages.findIndex((row) => row.id === id)
    );
  return end;
};

/** `decorate` with the chat's delivered reports drawn in among its messages. */
export const withRunReports = (
  decorate: Decorate,
  reports: readonly RunReportView[],
  isHidden?: (message: UIMessage, context: DecorationContext) => boolean
): Decorate => {
  if (reports.length === 0) return decorate;
  const cache = new WeakMap<
    readonly UIMessage[],
    ReturnType<typeof reportAnchors<RunReportView>>
  >();
  const anchorsFor = (context: DecorationContext) => {
    const hit = cache.get(context.messages);
    if (hit != null) return hit;
    const anchors = reportAnchors(context.messages, reports, (index) => {
      const message = context.messages[index]!;
      return (
        message.role !== "system" &&
        !hiddenUserMessage(message) &&
        isHidden?.(message, { ...context, index }) !== true
      );
    });
    cache.set(context.messages, anchors);
    return anchors;
  };
  return (message, context) => {
    const inner = decorate(message, context);
    let host = context.index;
    if (context.messages[host]?.id !== message.id)
      host = context.messages.findIndex((row) => row.id === message.id);
    if (host < 0 || inner?.hidden === true) return inner;
    const anchors = anchorsFor(context);
    const before: RunReportView[] = [];
    const after: RunReportView[] = [];
    for (let index = host; index <= rowEnd(context.messages, host); index++) {
      before.push(...(anchors.get(index)?.before ?? []));
      after.push(...(anchors.get(index)?.after ?? []));
    }
    if (before.length === 0 && after.length === 0) return inner;
    return {
      ...inner,
      before: (
        <>
          {before.map((report) => (
            <RunReportCard key={report.runSessionId} report={report} />
          ))}
          {inner?.before}
        </>
      ),
      after: (
        <>
          {inner?.after}
          {after.map((report) => (
            <RunReportCard key={report.runSessionId} report={report} />
          ))}
        </>
      ),
    };
  };
};
