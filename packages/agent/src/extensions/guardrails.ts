import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Originally ported from codingagent-lite (abacusai/codingagent-lite), MIT.
 *
 * File rules for cheap-model sloppiness: `write` over an existing file keeps
 * a copy; `edit` needs a read first; nothing is hand-written into .git or
 * node_modules; bash does not overwrite an existing secret file or `>` onto
 * an existing file. What a command does to this machine is the shell judge's
 * call: the permission gate asks about it, and where there is no gate
 * (sub-agents) this refuses what the gate would have asked about. Whether a
 * write may leave the workspace is the gate's question, not this one's.
 */
import {
  type ExtensionAPI,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";

import { memoryDir } from "../memory/notes.js";
import { modelPath } from "../model-path.js";
import { runOrigin } from "../network-wait.js";
import { namesSecretFile } from "../secret-files.js";
import {
  confirmRules,
  judgeCommand,
  logGuardVerdict,
  neverMessage,
  unattendedNote,
  type LocalWrite,
} from "../shell-judge.js";
import { isInsideDirectory, realPathOf } from "../workspace-path.js";

/**
 * Backups live inside the workspace, under `.abacusai-bot/` rather than beside
 * the original: a sibling `file.bak` shows up in git status and gets committed.
 */
const BACKUP_DIR = path.join(".abacusai-bot", "backups");

/**
 * Timestamped copies kept per file, oldest dropped first: a second overwrite
 * must not destroy the copy the first one made.
 */
const BACKUPS_PER_FILE = 5;

/** A secret file keeps one copy: every extra copy is another place its keys sit. */
const BACKUPS_PER_SECRET_FILE = 1;

/**
 * Above this a build artifact rewritten repeatedly would fill the disk a copy
 * at a time, so the write is refused instead of going through unbacked.
 */
const MAX_BACKUP_BYTES = 25 * 1024 * 1024;

/**
 * Folders the agent must not hand-write into: reinstall or use git instead.
 * The folder itself may go (`rm -rf node_modules`, which goes to the Trash),
 * and so may a package inside it, deleted to be reinstalled.
 */
const HYGIENE_PATTERN = /(^|\/)(\.git|node_modules)\//;
const GIT_INSIDE_PATTERN = /(^|\/)\.git\//;

/** A file the write tools must not touch: inside, or named, .git or node_modules. */
const PROTECTED_PATH_PATTERN = /(^|\/)(\.git|node_modules)(\/|$)/;

/**
 * Whether a resolved path is one the write tools must not modify. Backslashes
 * are folded to `/` on every platform (the patterns use `/`, Windows resolves
 * to `\`); a POSIX name containing a backslash may be refused, the safe error.
 * Secret files are not here: the write tools keep a copy before replacing one.
 */
export const isProtectedPath = (absolutePath: string): boolean =>
  PROTECTED_PATH_PATTERN.test(absolutePath.replace(/\\/g, "/")) ||
  // Memory changes only through the `memory` tool, which checks each one.
  isInsideDirectory(absolutePath, realPathOf(memoryDir()) ?? memoryDir());

/** Whether a shell write lands inside .git or node_modules, judged on the real path. */
function isHygieneWrite(write: LocalWrite, real: string): boolean {
  // `cp x node_modules/` writes into the folder, not over it.
  const into =
    write.kind === "copy" &&
    (/[\\/]$/.test(write.target) ||
      (fs.existsSync(real) && fs.statSync(real).isDirectory()));
  const landing = (into ? `${real}/x` : real).replace(/\\/g, "/");
  return write.kind === "delete"
    ? GIT_INSIDE_PATTERN.test(landing)
    : HYGIENE_PATTERN.test(landing);
}

/**
 * Temp dirs exempt from the overwrite-redirect guard: a server log in /tmp is
 * the agent's own file, rewritten every restart, and "append instead" makes
 * the model read yesterday's crash as today's. The platform temp dir's
 * realpath is included because the guards judge realpathed targets; it goes
 * through the same realPathOf so both sides agree (on Windows a plain
 * realpath keeps the 8.3 short name, while realPathOf expands it).
 */
const realTmpdir = realPathOf(os.tmpdir()) ?? os.tmpdir();

const SCRATCH_PREFIXES = [
  "/tmp/",
  "/private/tmp/",
  "/var/folders/",
  "/private/var/folders/",
  os.tmpdir() + path.sep,
  realTmpdir + path.sep,
];

/**
 * A routine's own records folder (`.abacusai-bot/routines/<id>/`, in the app's
 * folder or a project's): its notes and state files are rewritten every run,
 * so a routine's run may overwrite them there.
 */
const ROUTINE_RECORDS = /(^|\/)\.abacusai-bot\/routines\/[^/]+\//;

const isScratch = (abs: string): boolean => {
  // Windows paths compare case-insensitively, and C:/ and C:\ are one dir.
  const fold = (p: string): string => {
    const slashed = p.replace(/\\/g, "/");
    return process.platform === "win32" ? slashed.toLowerCase() : slashed;
  };
  const candidate = fold(abs);

  return SCRATCH_PREFIXES.some((prefix) => candidate.startsWith(fold(prefix)));
};

/**
 * Copy what is about to be replaced and return where it went, or null when
 * there was nothing to copy. The layout mirrors the workspace so two files
 * with the same name stay apart.
 */
function backUpExistingFile(abs: string, cwd: string): string | null {
  const relative = path.relative(cwd, abs);
  // A path outside the workspace has already been refused by the time we get
  // here; this is belt and braces against a backup escaping the project.
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;

  const directory = path.join(cwd, BACKUP_DIR, path.dirname(relative));
  fs.mkdirSync(directory, { recursive: true });

  // Self-ignoring: the workspace is someone else's repo and does not ignore
  // ours, so without this every backup reads as a file the agent left behind.
  fs.writeFileSync(path.join(cwd, BACKUP_DIR, ".gitignore"), "*\n");

  // Two rewrites within one millisecond share a stamp; take the next free name
  // rather than land on the older copy, which is the one a rescue wants.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(directory, `${path.basename(relative)}.${stamp}`);
  let destination = `${base}.bak`;
  for (let attempt = 2; fs.existsSync(destination); attempt += 1) {
    destination = `${base}-${attempt}.bak`;
  }
  fs.copyFileSync(abs, destination);

  pruneOldBackups(
    directory,
    path.basename(relative),
    namesSecretFile(relative) ? BACKUPS_PER_SECRET_FILE : BACKUPS_PER_FILE
  );

  return destination;
}

/** Keep the newest few copies of one file; drop the rest. */
function pruneOldBackups(directory: string, name: string, keep: number): void {
  try {
    const mine = fs
      .readdirSync(directory)
      .filter((entry) => entry.startsWith(`${name}.`) && entry.endsWith(".bak"))
      .sort();

    for (const stale of mine.slice(0, Math.max(0, mine.length - keep))) {
      fs.rmSync(path.join(directory, stale), { force: true });
    }
  } catch {
    // Pruning is housekeeping. Failing it must never fail the write that
    // prompted it, and the backup that matters has already been made.
  }
}

/** A secret by name below the workspace (or the real path's), like the gate's read check. */
function isSecretFile(lexical: string, real: string, cwd: string): boolean {
  const root = path.resolve(cwd);
  return (
    namesSecretFile(path.relative(root, lexical)) ||
    namesSecretFile(path.relative(realPathOf(root) ?? root, real))
  );
}

export interface GuardrailsOptions {
  /**
   * What a command the shell judge wants confirmed gets: "gate" where the
   * permission gate asks the user; "report" where nobody can, so it runs and
   * the result tells the run to say so in its report.
   */
  confirm: "gate" | "report";
}

export function createGuardrails(
  options: GuardrailsOptions
): (pi: ExtensionAPI) => void {
  return (pi) => guardrails(pi, options);
}

function guardrails(pi: ExtensionAPI, options: GuardrailsOptions): void {
  // Files read (or created by us) this session. In-memory by design: after a
  // restart the model must re-read before editing, which is the safe default.
  const knownFiles = new Set<string>();

  // Judged commands that ran with nobody to approve them, by call: the note
  // their result carries so the run's report says so.
  const reports = new Map<string, string>();

  // Files replaced this session and where the copy went. Consumed once by the
  // result hook; a stale entry would name an earlier write's copy as this one's.
  const backups = new Map<string, string>();

  // Resolve symlinks first, or `ln -s .git/config notes.txt` then a write to
  // notes.txt slips past on the name alone. realPathOf resolves the nearest existing
  // ancestor for a new file; an unresolvable path counts as protected.
  const isProtected = (abs: string): boolean => {
    const real = realPathOf(abs);

    return real === null || isProtectedPath(real);
  };

  // Judged on the real target: a link that sits in /tmp but points at
  // /etc/hosts is not scratch.
  const isRealScratch = (abs: string): boolean => {
    const real = realPathOf(abs);

    return real !== null && isScratch(real);
  };

  // Symlinks followed: writing through a link that points out of the workspace
  // writes outside it, which is what this guard exists to stop.
  const isInsideWorkspace = (abs: string, cwd: string) =>
    isInsideDirectory(abs, cwd);

  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("read", event)) {
      knownFiles.add(path.resolve(ctx.cwd, event.input.path));
      return;
    }

    // A batch read is a read of every file it names; otherwise read-before-edit
    // would reject an edit to a file the model was just shown.
    if (event.toolName === "batch_file_read") {
      const paths = (event.input as { paths?: unknown }).paths;
      if (Array.isArray(paths)) {
        for (const candidate of paths) {
          if (typeof candidate === "string")
            knownFiles.add(path.resolve(ctx.cwd, candidate));
        }
      }
      return;
    }

    if (isToolCallEventType("write", event)) {
      const abs = path.resolve(ctx.cwd, event.input.path);
      if (isProtected(abs)) {
        return {
          block: true,
          reason: `${event.input.path} is a protected path; do not modify it.`,
        };
      }
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        // Rewriting a whole file is legitimate; what made it dangerous was
        // that the previous contents were simply gone, so keep them.
        if (fs.statSync(abs).size > MAX_BACKUP_BYTES) {
          return {
            block: true,
            reason:
              `${event.input.path} is too large to keep a copy of before replacing it. ` +
              `Use the edit tool to change it in place (read it first if you have not this session).`,
          };
        }

        try {
          const backup = backUpExistingFile(abs, ctx.cwd);
          if (backup != null) backups.set(abs, path.relative(ctx.cwd, backup));
          // A secret file replaced is only safe with its copy kept.
          else if (isSecretFile(abs, realPathOf(abs) ?? abs, ctx.cwd))
            return {
              block: true,
              reason:
                `${event.input.path} holds keys or tokens and is outside the workspace, so no copy ` +
                `can be kept before replacing it. Change only the lines needed with the edit tool.`,
            };
        } catch (error) {
          // No copy means no safety net; refuse rather than let it through.
          return {
            block: true,
            reason:
              `Could not keep a copy of ${event.input.path} before replacing it ` +
              `(${error instanceof Error ? error.message : String(error)}). Use the edit tool instead.`,
          };
        }
      }
      return;
    }

    // batch_edit writes the same way edit does, so it answers to the same
    // rules. Matching by name because only `edit` has a built-in event type.
    if (isToolCallEventType("edit", event) || event.toolName === "batch_edit") {
      const requested = String((event.input as { path?: unknown }).path ?? "");
      const abs = path.resolve(ctx.cwd, requested);
      if (isProtected(abs)) {
        return {
          block: true,
          reason: `${requested} is a protected path; do not modify it.`,
        };
      }
      if (fs.existsSync(abs) && !knownFiles.has(abs)) {
        return {
          block: true,
          reason: `Read ${requested} before editing it, so your oldText matches the real content.`,
        };
      }
      return;
    }

    // ast_edit writes files too; not a built-in, so match by name.
    if (event.toolName === "ast_edit") {
      const input = event.input as { path?: unknown };
      if (typeof input.path === "string") {
        const abs = path.resolve(ctx.cwd, input.path);
        if (isProtected(abs)) {
          return {
            block: true,
            reason: `${input.path} is a protected path; do not modify it.`,
          };
        }
      }
      return;
    }

    if (isToolCallEventType("bash", event)) {
      const cmd = event.input.command ?? "";
      const judgement = judgeCommand(cmd, { cwd: ctx.cwd });
      // The gate refuses these too; here it also covers the sub-agents.
      if (judgement.verdict === "never") {
        if (options.confirm === "report")
          logGuardVerdict(
            "never",
            judgement.findings.map((finding) => finding.rule),
            "refused"
          );
        return { block: true, reason: neverMessage(judgement) };
      }
      const unasked =
        options.confirm === "report" ? confirmRules(judgement) : [];
      if (unasked.length > 0) {
        logGuardVerdict("confirm", unasked, "ran_unattended");
        reports.set(event.toolCallId, unattendedNote(unasked));
      }

      // Judged on the real target: a link cannot rename what it points at.
      for (const write of judgement.localWrites) {
        const real = realPathOf(write.path);
        if (real === null || isHygieneWrite(write, real)) {
          return {
            block: true,
            reason:
              `${write.target} is inside .git or node_modules; do not change it by hand. ` +
              `Reinstall the package, or use git, instead.`,
          };
        }
        if (
          write.kind !== "meta" &&
          isSecretFile(write.path, real, ctx.cwd) &&
          fs.existsSync(real)
        ) {
          return {
            block: true,
            reason:
              `${write.target} holds keys or tokens and already exists. Change it with the ` +
              `write or edit tool, which keeps a copy of what was there, not through the shell.`,
          };
        }
      }

      for (const write of judgement.localWrites) {
        if (write.kind !== "overwrite") continue;
        // A project checked out under /tmp keeps the guard; judged on the real
        // target so a link parked in /tmp cannot carry the redirect elsewhere.
        if (
          isRealScratch(write.path) &&
          !isInsideWorkspace(write.path, ctx.cwd)
        )
          continue;
        const real = realPathOf(write.path);
        if (
          runOrigin() === "routine" &&
          real !== null &&
          ROUTINE_RECORDS.test(real.replace(/\\/g, "/"))
        )
          continue;
        try {
          if (fs.statSync(write.path).isFile()) {
            return {
              block: true,
              reason:
                `The redirect \`> ${write.target}\` would overwrite an existing file. ` +
                `Use the edit tool for file changes, or \`>>\` to append.`,
            };
          }
        } catch {
          // Target doesn't exist → creating a new file via redirect is fine.
        }
      }
      return;
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const report = reports.get(event.toolCallId);
    if (report != null) {
      reports.delete(event.toolCallId);
      return {
        content: [...event.content, { type: "text" as const, text: report }],
      };
    }

    // A successful write means we know the file's content: allow future edits.
    if (event.toolName === "write" && !event.isError) {
      const input = event.input as { path?: string };
      if (!input.path) return;

      const abs = path.resolve(ctx.cwd, input.path);
      knownFiles.add(abs);

      // Name the copy: the model can only restore what a rewrite dropped if
      // it knows where the previous contents went.
      const backup = backups.get(abs);
      if (backup == null) return;
      backups.delete(abs);

      return {
        content: [
          ...event.content,
          {
            type: "text" as const,
            text:
              `The previous contents of ${input.path} were saved to ${modelPath(backup)}. ` +
              `If this rewrite lost something, restore it with: cp ${modelPath(backup)} ${input.path}`,
          },
        ],
      };
    }
  });
}
