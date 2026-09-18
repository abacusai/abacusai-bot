/**
 * What a shell command means to write outside the workspace, read from its
 * text, so the benign case can be let through without a card: a new file on
 * the Desktop, a directory beside the project, a build writing to its own
 * scaffold. The kernel stays the enforcer. This only ever adds the literal
 * paths a plainly-written command names to the write list for one run, and
 * only when everything the command names is benign; a command that deletes
 * or replaces something that is not its own, touches a sensitive place, or
 * cannot be read with confidence gets nothing, is refused by the kernel as
 * before, and the card then asks. A wrong reading here costs a card, never
 * grants one more than the command's own text.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { canonicalize } from "./policy.js";
import { type Zone, type ZoneContext, zoneOf } from "./zones.js";

export interface Intent {
  /** Paths to put on the kernel's write list for this run; empty unless benign. */
  grants: string[];
  /** Paths the run will have created if it succeeds, for the session ledger. */
  creates: string[];
  /** What kept the command from a grant, in words for the card. */
  concerns: string[];
}

export interface IntentOptions {
  context: ZoneContext;
  /** Paths this session created outside the workspace; its own to change. */
  ledger?: ReadonlySet<string>;
  /** For the tests; the real filesystem otherwise. */
  exists?: (target: string) => boolean;
  isDirectory?: (target: string) => boolean;
  home?: string;
}

const NOTHING: Intent = { grants: [], creates: [], concerns: [] };

/** The parts of a line, each its own command; `2>&1` survives, `a & b` does not. */
const SEGMENT_SPLIT = /\|\||&&|[;|\n]|&(?![>\d])/;

/**
 * Text whose meaning is not in the text: substitution, expansion, process
 * substitution. A path built from these cannot be granted from its spelling.
 * `$?`, `$$`, `$#` and `$!` are numbers and stay plain: a model likes to
 * finish a line with `echo "exit=$?"`, and that must not spoil the read.
 */
const OPAQUE = /\$\(|`|\$\{|<\(|>\(|\$[A-Za-z_@*0-9]/;

/** Runs code from an argument, so the verb says nothing about the writes. */
const INTERPRETERS = new Set([
  "eval",
  "source",
  ".",
  "exec",
  "xargs",
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "python",
  "python2",
  "python3",
  "node",
  "deno",
  "bun",
  "perl",
  "ruby",
  "php",
  "awk",
  "gawk",
  "osascript",
  "sudo",
  "doas",
]);

/** Stepped over to reach the real verb. */
const WRAPPERS = new Set(["env", "command", "nohup", "time", "nice"]);

/** Verbs that only create or touch what they name. */
const CREATORS = new Set(["touch", "mkdir"]);
/** Verbs that delete every operand. */
const DELETERS = new Set(["rm", "rmdir", "unlink", "shred"]);
/** Verbs that change permissions or ownership of every operand after the first. */
const MODE_CHANGERS = new Set(["chmod", "chown", "chgrp"]);
/** Verbs that copy their operands onto the last one. */
const COPIERS = new Set(["cp", "install", "rsync", "ln"]);

/** Redirects to a path: `> f`, `>> f`, `2> f`; not `2>&1`. */
const REDIRECT = /(?<![<>])(\d*)(>>?)\s*(?!&)("[^"]*"|'[^']*'|[^\s;|&()<>]+)/g;

type Op =
  | "touch"
  | "mkdir"
  | "create"
  | "into"
  | "append"
  | "overwrite"
  | "delete"
  | "mode";

interface Write {
  target: string;
  op: Op;
}

const unquote = (word: string): string =>
  (word.startsWith('"') && word.endsWith('"')) ||
  (word.startsWith("'") && word.endsWith("'"))
    ? word.slice(1, -1)
    : word;

function words(segment: string): string[] {
  return (segment.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g) ?? [])
    .map(unquote)
    .filter((word) => word.length > 0);
}

/** An odd quote means the split above cut through a string: unreadable. */
function quotesBalance(segment: string): boolean {
  const unescaped = segment.replace(/\\./g, "");
  const doubles = (unescaped.match(/"/g) ?? []).length;
  const singles = (unescaped.match(/'/g) ?? []).length;

  return doubles % 2 === 0 && singles % 2 === 0;
}

/** A leading `-x` is a flag; `-` alone is stdin, and `--` ends the flags. */
function operands(rest: readonly string[]): string[] {
  const end = rest.indexOf("--");
  const flags = end >= 0 ? rest.slice(0, end) : rest;
  const plain = end >= 0 ? rest.slice(end + 1) : [];

  return [
    ...flags.filter((word) => !word.startsWith("-") || word === "-"),
    ...plain,
  ];
}

function hasFlag(
  rest: readonly string[],
  letter: string,
  long?: string
): boolean {
  return rest.some(
    (word) =>
      (long != null && word === long) ||
      (/^-[a-zA-Z]+$/.test(word) && word.includes(letter))
  );
}

export function classifyCommand(
  command: string,
  cwd: string,
  options: IntentOptions
): Intent {
  // Written for a POSIX shell; a Windows line is left to the kernel.
  if (process.platform === "win32") return NOTHING;

  const exists = options.exists ?? fs.existsSync;
  const isDirectory =
    options.isDirectory ??
    ((target: string): boolean => {
      try {
        return fs.statSync(target).isDirectory();
      } catch {
        return false;
      }
    });
  const home = options.home ?? os.homedir();
  const context: ZoneContext = { ...options.context, home };
  const ledger = new Set(options.ledger ?? []);

  const grants = new Set<string>();
  const creates = new Set<string>();
  const concerns: string[] = [];
  let effectiveCwd = canonicalize(cwd);

  const resolve = (raw: string): string => {
    const expanded =
      raw === "~"
        ? home
        : raw.startsWith("~/")
          ? path.join(home, raw.slice(2))
          : raw;

    return canonicalize(path.resolve(effectiveCwd, expanded));
  };

  const segments = command
    .split(SEGMENT_SPLIT)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return NOTHING;

  for (const segment of segments) {
    if (!quotesBalance(segment) || OPAQUE.test(segment)) {
      return {
        ...NOTHING,
        // A predicate: the card reads it after "The command".
        concerns: ["is not plain enough to read"],
      };
    }

    const writes: Write[] = [];

    for (const match of segment.matchAll(REDIRECT)) {
      const target = resolve(unquote(match[3]!));
      if (target === "/dev/null" || target.startsWith("/dev/")) continue;
      writes.push({
        target,
        op:
          match[2] === ">>"
            ? "append"
            : exists(target)
              ? "overwrite"
              : "create",
      });
    }

    const all = words(segment.replace(REDIRECT, " "));
    let index = 0;
    while (
      index < all.length &&
      (WRAPPERS.has(all[index]!) ||
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(all[index]!))
    ) {
      index += 1;
    }
    const verb = path.basename(all[index] ?? "");
    const rest = all.slice(index + 1);
    const args = operands(rest);

    if (verb.length === 0) {
      // A bare redirect (`> file`) is a create; nothing else to read.
    } else if (INTERPRETERS.has(verb)) {
      return {
        ...NOTHING,
        concerns: [`${verb} runs whatever its argument says`],
      };
    } else if (
      verb === "find" &&
      rest.some((word) => /^-(exec|execdir|ok|okdir)$/.test(word))
    ) {
      return {
        ...NOTHING,
        concerns: ["find -exec runs whatever its argument says"],
      };
    } else if (verb === "cd" || verb === "pushd") {
      if (args.length === 0) effectiveCwd = canonicalize(home);
      else if (args[0] === "-")
        return {
          ...NOTHING,
          concerns: ["cd - depends on where the shell was"],
        };
      else effectiveCwd = resolve(args[0]!);
      continue;
    } else if (CREATORS.has(verb)) {
      for (const arg of args)
        writes.push({ target: resolve(arg), op: verb as Op });
    } else if (DELETERS.has(verb)) {
      for (const arg of args)
        writes.push({ target: resolve(arg), op: "delete" });
    } else if (verb === "find" && rest.includes("-delete")) {
      writes.push({ target: resolve(args[0] ?? "."), op: "delete" });
    } else if (MODE_CHANGERS.has(verb)) {
      for (const arg of args.slice(1))
        writes.push({ target: resolve(arg), op: "mode" });
    } else if (verb === "mv") {
      if (args.length >= 2) {
        for (const source of args.slice(0, -1))
          writes.push({ target: resolve(source), op: "delete" });
        writes.push(
          landing(resolve(args[args.length - 1]!), exists, isDirectory)
        );
      }
    } else if (COPIERS.has(verb)) {
      if (
        verb === "rsync" &&
        rest.some((word) => word.startsWith("--delete"))
      ) {
        if (args.length >= 1)
          writes.push({
            target: resolve(args[args.length - 1]!),
            op: "delete",
          });
      } else if (args.length >= 2) {
        writes.push(
          landing(resolve(args[args.length - 1]!), exists, isDirectory)
        );
      }
    } else if (verb === "tee") {
      const append = hasFlag(rest, "a", "--append");
      for (const arg of args) {
        const target = resolve(arg);
        writes.push({
          target,
          op: append ? "append" : exists(target) ? "overwrite" : "create",
        });
      }
    } else if (verb === "sed") {
      if (
        rest.some((word) => /^-[a-zA-Z]*i/.test(word) || word === "--in-place")
      )
        for (const arg of args.slice(1))
          writes.push({ target: resolve(arg), op: "overwrite" });
    } else if (verb === "truncate") {
      if (args.length > 0)
        writes.push({
          target: resolve(args[args.length - 1]!),
          op: "overwrite",
        });
    } else if (verb === "dd") {
      for (const word of rest) {
        if (word.startsWith("of=")) {
          const target = resolve(word.slice(3));
          writes.push({ target, op: exists(target) ? "overwrite" : "create" });
        }
      }
    } else if (verb === "git" && rest[0] === "clone") {
      const repo = args[1];
      const dir =
        args[2] ??
        (repo != null ? path.basename(repo).replace(/\.git$/, "") : "");
      if (dir.length > 0) writes.push({ target: resolve(dir), op: "create" });
    } else if (verb === "git" && rest[0] === "clean") {
      writes.push({ target: effectiveCwd, op: "delete" });
    } else if (effectiveCwd !== context.workspaceRoot) {
      // Any other command run from a directory outside the workspace works
      // in it; fine when that directory is the session's own.
      writes.push({ target: effectiveCwd, op: "into" });
    }

    for (const write of writes) {
      const zone = zoneOf(
        write.target,
        context,
        write.op === "mkdir" || write.op === "into" || isDirectory(write.target)
      );
      const verdict = judge(write, zone, ledger);
      if (verdict === "kernel") continue;
      if (verdict === "grant") {
        grants.add(write.target);
        if (
          write.op === "create" ||
          write.op === "mkdir" ||
          write.op === "touch"
        ) {
          creates.add(write.target);
          ledger.add(write.target);
        }
        continue;
      }
      concerns.push(describe(write, zone));
    }
  }

  // One refusal means no grant at all: a grant for the create is the parent
  // directory once widened, and the delete beside it must not ride on it.
  if (concerns.length > 0) return { grants: [], creates: [], concerns };

  return { grants: [...grants], creates: [...creates], concerns: [] };
}

/** Copying onto an existing directory writes into it; onto a file replaces it. */
function landing(
  target: string,
  exists: (target: string) => boolean,
  isDirectory: (target: string) => boolean
): Write {
  if (!exists(target)) return { target, op: "create" };

  return { target, op: isDirectory(target) ? "into" : "overwrite" };
}

/**
 * The rule: in the user's own folders a command may make new things, and
 * may change or remove what this session made; everything else asks. The
 * workspace, scratch and tool homes are the kernel's own list already.
 */
function judge(
  write: Write,
  zone: Zone,
  ledger: ReadonlySet<string>
): "kernel" | "grant" | "ask" {
  if (zone === "workspace" || zone === "scratch" || zone === "toolhome")
    return "kernel";
  if (zone !== "user") return "ask";

  switch (write.op) {
    case "touch":
    case "mkdir":
    case "create":
    case "into":
      return "grant";
    default:
      return [...ledger].some(
        (own) =>
          write.target === own || write.target.startsWith(`${own}${path.sep}`)
      )
        ? "grant"
        : "ask";
  }
}

function describe(write: Write, zone: Zone): string {
  const where =
    zone === "sensitive"
      ? "a sensitive location"
      : zone === "user"
        ? "outside the workspace"
        : "outside the workspace and the user's folders";
  const what =
    write.op === "delete"
      ? "deletes"
      : write.op === "overwrite"
        ? "replaces"
        : write.op === "append"
          ? "appends to"
          : write.op === "mode"
            ? "changes permissions of"
            : write.op === "into"
              ? "writes into"
              : "creates";

  return `${what} ${write.target} (${where})`;
}
