import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Ported from codingagent-lite (abacusai/codingagent-lite), MIT; only the
 * env-var prefix changed (CALITE_* -> ABACUSAI_BOT_*).
 *
 * Guardrails for cheap-model sloppiness: `write` over an existing file keeps
 * a copy; `edit` needs a read first; protected paths are refused; bash is
 * denied destructive commands and `>` onto an existing file. Whether a write
 * may leave the workspace is the permission gate's question, not this one's.
 */
import {
  type ExtensionAPI,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";

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

/**
 * Above this a build artifact rewritten repeatedly would fill the disk a copy
 * at a time, so the write is refused instead of going through unbacked.
 */
const MAX_BACKUP_BYTES = 25 * 1024 * 1024;

const PROTECTED_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
];

/**
 * Whether a resolved path is one the agent must not modify. Backslashes are
 * folded to `/` on every platform (the patterns use `/`, Windows resolves to
 * `\`); a POSIX name containing a backslash may be refused, the safe error.
 */
export const isProtectedPath = (absolutePath: string): boolean => {
  const normalized = absolutePath.replace(/\\/g, "/");

  return PROTECTED_PATH_PATTERNS.some((re) => re.test(normalized));
};

/** Shell separators that end one command and start the next. */
const SEGMENT_SPLIT = /\|\||&&|[;|\n]/;

/**
 * Commands where every operand is written to. `touch`, `chmod` and `chown`
 * change the file if not its contents, which is what the guard is about.
 */
const WRITES_EVERY_OPERAND = new Set([
  "tee",
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "truncate",
  "touch",
  "chmod",
  "chown",
  "mkdir",
]);

/** Commands where only the last operand is written to. */
const WRITES_LAST_OPERAND = new Set(["cp", "mv", "install", "ln", "rsync"]);

/** Prefixes that run another command, and are not the write themselves. */
const WRAPPER_COMMANDS = new Set([
  "sudo",
  "doas",
  "env",
  "command",
  "nohup",
  "time",
]);

/**
 * Redirect targets, `>>` included: the overwrite guard only minds a bare `>`,
 * but for protected paths appending to `.env` is exactly as bad. The
 * lookbehind stops `>>` counting twice; `(?!&)` keeps `2>&1` from reading as
 * a write to a file called `&1`.
 */
const REDIRECT_TARGET_RE = /(?<!>)(?:\d+|&)?>>?\s*(?!&)([^\s;|&()<>]+)/g;

const unquote = (word: string): string => word.replace(/^["']|["']$/g, "");

/** Words of one segment, with quotes stripped and quoted spaces respected. */
function shellWords(segment: string): string[] {
  const words = segment.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];

  return words.map(unquote).filter((word) => word.length > 0);
}

/**
 * Paths a command spells out as write targets. Deliberately syntactic: the
 * kernel sandbox, not this, answers a subshell or variable built to evade it.
 * Commands that touch a protected path without naming it pass, which keeps
 * `git commit` and `npm install` working.
 */
export function bashWriteTargets(command: string): string[] {
  const targets: string[] = [];

  for (const segment of command.split(SEGMENT_SPLIT)) {
    for (const match of segment.matchAll(REDIRECT_TARGET_RE)) {
      if (match[1]) targets.push(unquote(match[1]));
    }

    const words = shellWords(segment.replace(REDIRECT_TARGET_RE, " "));
    // `sudo cp …`, `env FOO=1 rm …`: step over the wrapper to the real verb.
    let index = 0;
    while (
      index < words.length &&
      (WRAPPER_COMMANDS.has(words[index]!) || words[index]!.includes("="))
    ) {
      index += 1;
    }

    const verb = path.basename(words[index] ?? "");
    const rest = words.slice(index + 1);
    const operands = rest.filter((word) => !word.startsWith("-"));

    if (verb === "dd") {
      for (const word of rest) {
        if (word.startsWith("of=")) targets.push(word.slice(3));
      }
      continue;
    }

    // Only `-i` makes sed a writer; without it the file is just read.
    if (verb === "sed") {
      if (rest.some((word) => /^-[a-zA-Z]*i/.test(word)))
        targets.push(...operands.slice(1));
      continue;
    }

    if (WRITES_EVERY_OPERAND.has(verb)) targets.push(...operands);
    // A link's target is read; the name being created is the write.
    else if (WRITES_LAST_OPERAND.has(verb) && operands.length > 1)
      targets.push(operands[operands.length - 1]!);
  }

  return targets.filter((target) => target !== "/dev/null");
}

const BASH_DENY_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bsudo\b/, reason: "sudo is not available to the agent" },
  { re: /\brm\s+(-\w*[rf]\w*\s+)*(\/|~)(\s|$)/, reason: "rm on / or ~" },
  {
    re: /\brm\s+(-\w*\s+)*\/(bin|boot|dev|etc|lib|proc|root|sbin|sys|usr|var)\b/,
    reason: "rm on a system directory",
  },
  {
    re: /\bgit\s+push\b[^\n]*(--force|-f\b)/,
    reason: "force-push is blocked; push normally or ask the user",
  },
  { re: /\bchmod\s+(-\w+\s+)*777\b/, reason: "chmod 777" },
  {
    re: /\b(curl|wget)\b[^\n|]*\|\s*(ba|z|da)?sh\b/,
    reason: "piping a download into a shell",
  },
  { re: /\bdd\b[^\n]*\bof=\/dev\//, reason: "dd onto a device" },
  { re: /\bmkfs\b/, reason: "mkfs" },
  { re: /\b(shutdown|reboot|halt)\b/, reason: "system power command" },
  { re: /:\(\)\s*\{[^}]*\}\s*;\s*:/, reason: "fork bomb" },
];

// A bare `>` redirect (not >>, not 2>, not >&) followed by a target path.
const OVERWRITE_REDIRECT_RE = /(?<![>\d&])>(?![>&|=])\s*([^\s;|&()<>]+)/g;

/**
 * Temp dirs exempt from the overwrite-redirect guard: a server log in /tmp is
 * the agent's own file, rewritten every restart, and "append instead" makes
 * the model read yesterday's crash as today's. The platform temp dir's
 * realpath is included because the guards judge realpath()ed targets.
 */
const realTmpdir = (() => {
  try {
    return fs.realpathSync.native(os.tmpdir());
  } catch {
    try {
      return fs.realpathSync(os.tmpdir());
    } catch {
      return os.tmpdir();
    }
  }
})();

const SCRATCH_PREFIXES = [
  "/tmp/",
  "/private/tmp/",
  "/var/folders/",
  "/private/var/folders/",
  os.tmpdir() + path.sep,
  realTmpdir + path.sep,
];

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

  pruneOldBackups(directory, path.basename(relative));

  return destination;
}

/** Keep the newest few copies of one file; drop the rest. */
function pruneOldBackups(directory: string, name: string): void {
  try {
    const mine = fs
      .readdirSync(directory)
      .filter((entry) => entry.startsWith(`${name}.`) && entry.endsWith(".bak"))
      .sort();

    for (const stale of mine.slice(
      0,
      Math.max(0, mine.length - BACKUPS_PER_FILE)
    )) {
      fs.rmSync(path.join(directory, stale), { force: true });
    }
  } catch {
    // Pruning is housekeeping. Failing it must never fail the write that
    // prompted it, and the backup that matters has already been made.
  }
}

export default function (pi: ExtensionAPI) {
  // Files read (or created by us) this session. In-memory by design: after a
  // restart the model must re-read before editing, which is the safe default.
  const knownFiles = new Set<string>();

  // Files replaced this session and where the copy went. Consumed once by the
  // result hook; a stale entry would name an earlier write's copy as this one's.
  const backups = new Map<string, string>();

  // Resolve symlinks first, or `ln -s .env notes.txt` then a write to notes.txt
  // slips past on the name alone. realPathOf resolves the nearest existing
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
      for (const { re, reason } of BASH_DENY_PATTERNS) {
        if (re.test(cmd)) {
          return {
            block: true,
            reason: `Command blocked (${reason}). Find a safer way or ask the user.`,
          };
        }
      }
      // The write tools refuse these paths, so a model reaches for the shell
      // (`printf … >> .env`). Same policy, judged on the same realpath'd target.
      for (const target of bashWriteTargets(cmd)) {
        const abs = path.resolve(ctx.cwd, target);
        if (isProtected(abs)) {
          return {
            block: true,
            reason:
              `${target} is a protected path; do not modify it. ` +
              `Reaching it through the shell is refused for the same reason the write tool refuses it.`,
          };
        }
      }
      for (const match of cmd.matchAll(OVERWRITE_REDIRECT_RE)) {
        const target = match[1];
        if (!target || target === "/dev/null") continue;
        const abs = path.resolve(ctx.cwd, target.replace(/^["']|["']$/g, ""));
        // A project checked out under /tmp keeps the guard; judged on the real
        // target so a link parked in /tmp cannot carry the redirect elsewhere.
        if (isRealScratch(abs) && !isInsideWorkspace(abs, ctx.cwd)) continue;
        try {
          if (fs.statSync(abs).isFile()) {
            return {
              block: true,
              reason:
                `The redirect \`> ${target}\` would overwrite an existing file. ` +
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
              `The previous contents of ${input.path} were saved to ${backup}. ` +
              `If this rewrite lost something, restore it with: cp ${backup} ${input.path}`,
          },
        ],
      };
    }
  });
}
