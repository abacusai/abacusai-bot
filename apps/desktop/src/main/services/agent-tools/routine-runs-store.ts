/**
 * A routine's own folder. Every run is a fresh session, so the memory lives
 * here: `runs/` holds one file per finished run and `notes.md` is the
 * routine's scratch space. A routine with no project of its own lives at
 * `~/.abacusai-bot/routines/<id>/`, which is also its workspace; one set up
 * for a project keeps its records inside that project, so the whole routine
 * runs where the user pointed it. The host resolves the folder once and every
 * function here takes it.
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

/** The app's own folder for a routine, used when it has no project. */
export const routineDir = (routineId: string): string =>
  path.join(abacusBotHome(), "routines", routineId);

/**
 * Where a routine set up for a project keeps its records: inside the project,
 * under the app's own dot-folder, beside the backups the file tools keep.
 */
export const routineDirInWorkspace = (
  workspacePath: string,
  routineId: string
): string => path.join(workspacePath, ".abacusai-bot", "routines", routineId);

export const routineRunsDir = (home: string): string => path.join(home, "runs");

export const routineNotesPath = (home: string): string =>
  path.join(home, "notes.md");

const LAST_RUN = "last-run.json";

/**
 * Records inside a project are the app's, not the project's: ignore them the
 * way the backup folder ignores itself, so they never show up in git status.
 */
const selfIgnore = (home: string): void => {
  const dotDir = path.join(path.dirname(path.dirname(home)));
  if (path.basename(dotDir) !== ".abacusai-bot") return;
  const ignore = path.join(dotDir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n", "utf8");
};

/** File-name safe and sortable: the start time first, then the session. */
const runFileName = (record: RoutineRunRecord): string =>
  `${record.startedAt.replaceAll(":", "-")}-${record.sessionId}.md`;

export const recordRoutineRun = (
  home: string,
  record: RoutineRunRecord
): void => {
  const dir = routineRunsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  selfIgnore(home);
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
  const current = readLastRoutineRun(home);
  if (current != null && current.startedAt > record.startedAt) return;
  fs.writeFileSync(
    path.join(home, LAST_RUN),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8"
  );
};

export const readLastRoutineRun = (home: string): RoutineRunRecord | null => {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(home, LAST_RUN), "utf8")
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
export const countRoutineRuns = (home: string): number => {
  try {
    return fs
      .readdirSync(routineRunsDir(home))
      .filter((name) => name.endsWith(".md")).length;
  } catch {
    return 0;
  }
};

/** Remove a routine's records folder; never anything above it. */
export const removeRoutineDir = (home: string): void => {
  fs.rmSync(home, { recursive: true, force: true });
};
