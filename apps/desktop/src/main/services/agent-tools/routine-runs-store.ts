/**
 * A routine's own folder. Every run is a fresh session, so the memory lives
 * here: `runs/` holds one file per finished run and `notes.md` is the
 * routine's scratch space (`routineNotes` alone decides where that is). A routine with no project of its own lives at
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
  outcome: "completed" | "failed" | "offline" | "interrupted";
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

const LAST_RUN = "last-run.json";

/** What a run file says in place of a reply when the run said nothing. */
const NOTHING_SAID = "(the run said nothing)";

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

/** Where a routine's notes are, as the fire prompt names them. */
export interface RoutineNotes {
  path: string;
  /** Earlier runs kept notes there. */
  kept: boolean;
  /**
   * A notes.md at the project root that changed after the routine was made,
   * when it kept none: runs were once told a bare "notes.md", which resolves
   * there. It may as well be the user's own, so it is named, never moved.
   */
  maybeAt: string | null;
}

const NOTES_FILE = "notes.md";

/** Across volumes too: a project can sit on another drive than the app. */
const moveFile = (from: string, to: string): void => {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fs.rmSync(from);
  }
};

/**
 * The routine's notes live in its records folder. Notes in the app's own
 * folder for it (its records folder before it had a project) are its alone,
 * so they move in once; if that fails they are named where they are.
 */
export const routineNotes = (
  home: string,
  routineId: string,
  project: { path: string; since: number } | null
): RoutineNotes => {
  const notes = path.join(home, NOTES_FILE);
  if (fs.existsSync(notes)) return { path: notes, kept: true, maybeAt: null };
  const appNotes = path.join(routineDir(routineId), NOTES_FILE);
  if (appNotes !== notes && fs.existsSync(appNotes)) {
    try {
      fs.mkdirSync(home, { recursive: true });
      selfIgnore(home);
      moveFile(appNotes, notes);
      return { path: notes, kept: true, maybeAt: null };
    } catch (error) {
      console.warn("Could not move a routine's notes", error);
      return { path: appNotes, kept: true, maybeAt: null };
    }
  }
  let maybeAt: string | null = null;
  if (project != null) {
    const rootNotes = path.join(project.path, NOTES_FILE);
    try {
      const stat = fs.statSync(rootNotes);
      // Unchanged since before the routine existed: none of its runs wrote it.
      if (stat.isFile() && stat.mtimeMs >= project.since) maybeAt = rootNotes;
    } catch {
      // No such file.
    }
  }
  return { path: notes, kept: false, maybeAt };
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
    record.reply.length > 0 ? record.reply : NOTHING_SAID,
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
      outcome:
        record.outcome === "failed" ||
        record.outcome === "offline" ||
        record.outcome === "interrupted"
          ? record.outcome
          : "completed",
      reply: record.reply,
    };
  } catch {
    return null;
  }
};

/** A run file as `recordRoutineRun` wrote it, or null when it is not one. */
const readRunFile = (file: string): RoutineRunRecord | null => {
  const text = fs.readFileSync(file, "utf8");
  const head =
    /^# Run at (\S+)\n\n- Outcome: (\w+)\n- Ended: (\S+)\n- Session: (\S*)\n\n/.exec(
      text
    );
  if (head == null) return null;
  const reply = text.slice(head[0].length).trim();
  return {
    startedAt: head[1]!,
    outcome: head[2] as RoutineRunRecord["outcome"],
    endedAt: head[3]!,
    sessionId: head[4]!,
    reply: reply === NOTHING_SAID ? "" : reply,
  };
};

/** The newest runs on file, newest first, at most `limit`. */
export const recentRoutineRuns = (
  home: string,
  limit: number
): RoutineRunRecord[] => {
  let names: string[];
  try {
    names = fs.readdirSync(routineRunsDir(home));
  } catch {
    // No run has finished yet.
    return [];
  }
  return names
    .filter((name) => name.endsWith(".md"))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((name) => readRunFile(path.join(routineRunsDir(home), name)))
    .filter((record): record is RoutineRunRecord => record != null);
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
export const removeRoutineDir = async (home: string): Promise<void> => {
  await fs.promises.rm(home, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
};
