/**
 * A routine's own folder, `~/.abacusai-bot/routines/<id>/`. Every run is a
 * fresh session, so the memory lives here: `runs/` holds one file per finished
 * run and `notes.md` is the routine's scratch space. A fire is told the path.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { abacusBotHome } from "../../paths";

export interface RoutineRunRecord {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  outcome: "completed" | "failed";
  /** Everything the run said, assistant text only. */
  reply: string;
}

export const routineDir = (routineId: string): string =>
  path.join(abacusBotHome(), "routines", routineId);

export const routineRunsDir = (routineId: string): string =>
  path.join(routineDir(routineId), "runs");

export const routineNotesPath = (routineId: string): string =>
  path.join(routineDir(routineId), "notes.md");

const LAST_RUN = "last-run.json";

/** File-name safe and sortable: the start time first, then the session. */
const runFileName = (record: RoutineRunRecord): string =>
  `${record.startedAt.replaceAll(":", "-")}-${record.sessionId}.md`;

export const recordRoutineRun = (
  routineId: string,
  record: RoutineRunRecord
): void => {
  const dir = routineRunsDir(routineId);
  fs.mkdirSync(dir, { recursive: true });
  const body = [
    `# Run at ${record.startedAt}`,
    "",
    `- Outcome: ${record.outcome}`,
    `- Ended: ${record.endedAt}`,
    `- Session: ${record.sessionId}`,
    "",
    record.reply.length > 0 ? record.reply : "(the run said nothing)",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, runFileName(record)), body, "utf8");
  // Runs finish out of order, so "last" is the run that started last, not
  // the one that wrote last.
  const current = readLastRoutineRun(routineId);
  if (current != null && current.startedAt > record.startedAt) return;
  fs.writeFileSync(
    path.join(routineDir(routineId), LAST_RUN),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8"
  );
};

export const readLastRoutineRun = (
  routineId: string
): RoutineRunRecord | null => {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(routineDir(routineId), LAST_RUN), "utf8")
    );
    if (parsed == null || typeof parsed !== "object") return null;
    const record = parsed as Partial<RoutineRunRecord>;
    if (
      typeof record.startedAt !== "string" ||
      typeof record.reply !== "string"
    )
      return null;
    return {
      sessionId: String(record.sessionId ?? ""),
      startedAt: record.startedAt,
      endedAt: String(record.endedAt ?? record.startedAt),
      outcome: record.outcome === "failed" ? "failed" : "completed",
      reply: record.reply,
    };
  } catch {
    return null;
  }
};

/** How many runs are on file, for the prompt's own sense of scale. */
export const countRoutineRuns = (routineId: string): number => {
  try {
    return fs
      .readdirSync(routineRunsDir(routineId))
      .filter((name) => name.endsWith(".md")).length;
  } catch {
    return 0;
  }
};

export const removeRoutineDir = (routineId: string): void => {
  fs.rmSync(routineDir(routineId), { recursive: true, force: true });
};
