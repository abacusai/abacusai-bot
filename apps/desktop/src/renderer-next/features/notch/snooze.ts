export interface Snooze {
  lineage: string;
  summaryKey: string;
  sessionId: string;
  expiresAt: number;
  connector: boolean;
}
export const permissionLineageKey = (lineage: {
  threadId: string;
  incarnation: string;
  turnSeq: number;
  permissionId: string;
}): string =>
  JSON.stringify([
    lineage.threadId,
    lineage.incarnation,
    lineage.turnSeq,
    lineage.permissionId,
  ]);
export const activeSnoozes = (
  records: ReadonlyMap<string, Snooze>,
  now: number,
  currentLineage: (sessionId: string) => string | undefined
): ReadonlySet<string> =>
  new Set(
    [...records.values()]
      .filter((record) => {
        if (record.expiresAt <= now) return false;
        const current = record.connector
          ? record.lineage
          : currentLineage(record.sessionId);
        return current === undefined || current === record.lineage;
      })
      .map((record) => record.summaryKey)
  );
