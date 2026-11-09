/**
 * GNU grep's options on the Windows shell, whose grep is BusyBox's.
 *
 * BusyBox grep has no long options, no --include/--exclude/--exclude-dir, no
 * -P, and reads stdin for `grep -r PATTERN` with no file. It answers the
 * first three with a usage message that `2>/dev/null` hides, so a search a
 * model writes in GNU's dialect reads as "no matches". The `grep` launcher
 * (grep-launcher.ts) sends a command here when it uses such an option or
 * recurses. Basic, extended and fixed patterns stay on BusyBox's matcher, with
 * the files chosen here; -P goes to ripgrep, whose PCRE2 is the engine GNU
 * grep -P uses.
 *
 * Node builtins only, and no imports of the agent: it starts once per command.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as tty from "node:tty";

/** The busybox executable that runs `grep` as its first argument; grep-launcher.ts sets it. */
export const GREP_BUSYBOX_ENV = "ABACUSAI_BOT_BUSYBOX";

/** The ripgrep the app ships, which -P uses ahead of any other on PATH; grep-launcher.ts sets it. */
export const GREP_RG_ENV = "ABACUSAI_BOT_RG";

/** Single-letter flags BusyBox grep takes as GNU does. */
const PASS_FLAGS = new Set("ivwxclLoqsHhnIa");

/** Options only ripgrep can honour, so only with -P: GNU name -> ripgrep argument. */
const RG_ONLY: Record<string, string> = {
  b: "--byte-offset",
  Z: "--null",
  z: "--null-data",
};

/** GNU's long options, with the short option each is, or what it means here. */
const LONG: Record<string, string> = {
  "extended-regexp": "E",
  "fixed-strings": "F",
  "basic-regexp": "G",
  "perl-regexp": "P",
  regexp: "e=",
  file: "f=",
  "ignore-case": "i",
  "no-ignore-case": "no-ignore-case",
  "word-regexp": "w",
  "line-regexp": "x",
  "null-data": "z",
  "no-messages": "s",
  "invert-match": "v",
  version: "V",
  help: "help",
  "max-count": "m=",
  "byte-offset": "b",
  "line-number": "n",
  "line-buffered": "noop",
  "with-filename": "H",
  "no-filename": "h",
  label: "unsupported=",
  "only-matching": "o",
  quiet: "q",
  silent: "q",
  "binary-files": "binary-files=",
  text: "a",
  directories: "d=",
  devices: "D=",
  recursive: "r",
  "dereference-recursive": "R",
  include: "include=",
  exclude: "exclude=",
  "exclude-from": "exclude-from=",
  "exclude-dir": "exclude-dir=",
  "files-without-match": "L",
  "files-with-matches": "l",
  count: "c",
  "initial-tab": "unsupported",
  null: "Z",
  "before-context": "B=",
  "after-context": "A=",
  context: "C=",
  "group-separator": "group-separator=",
  "no-group-separator": "no-group-separator",
  color: "color",
  colour: "color",
  binary: "noop",
};

/** Short options that take a value. */
const SHORT_WITH_VALUE = new Set("efmABCdD");

/** One grep command line, read the way GNU grep reads it. */
export interface GrepCommand {
  matcher: "G" | "E" | "F" | "P";
  flags: Set<string>;
  /** -m, -A, -B and -C, by letter. */
  values: Map<string, string>;
  patterns: string[];
  patternFiles: string[];
  include: string[];
  exclude: string[];
  excludeDir: string[];
  /** ripgrep arguments for options only it has. */
  rgOnly: string[];
  /** Files and directories to search, the pattern taken out. */
  files: string[];
  /** Asked for --help or --version. */
  info?: "help" | "version";
}

/** A command grep cannot run as written; the message names why. */
export class GrepUsageError extends Error {}

/** Expands `{a,b}` the way bash would have before GNU grep saw the glob; ash does not. */
function expandBraces(glob: string): string[] {
  const match = /\{([^{}]*,[^{}]*)\}/.exec(glob);
  if (match == null) return [glob];
  const head = glob.slice(0, match.index);
  const tail = glob.slice(match.index + match[0].length);

  return match[1]!
    .split(",")
    .flatMap((part) => expandBraces(`${head}${part}${tail}`));
}

/** Reads GNU grep's arguments: options anywhere before `--`, long ones by any unique prefix. */
export function parseGrepArgs(args: readonly string[]): GrepCommand {
  const command: GrepCommand = {
    matcher: "G",
    flags: new Set(),
    values: new Map(),
    patterns: [],
    patternFiles: [],
    include: [],
    exclude: [],
    excludeDir: [],
    rgOnly: [],
    files: [],
  };
  const operands: string[] = [];
  let explicitPattern = false;
  let matcherGiven = false;

  const apply = (option: string, value: string | undefined, name: string) => {
    switch (option) {
      case "E":
      case "F":
      case "G":
      case "P":
        if (matcherGiven && command.matcher !== option)
          throw new GrepUsageError("conflicting matchers specified");
        command.matcher = option;
        matcherGiven = true;
        return;
      case "e":
        command.patterns.push(value!);
        explicitPattern = true;
        return;
      case "f":
        command.patternFiles.push(value!);
        explicitPattern = true;
        return;
      case "y":
        command.flags.add("i");
        return;
      case "no-ignore-case":
        command.flags.delete("i");
        return;
      case "r":
      case "R":
        command.flags.add(option);
        return;
      case "m":
      case "A":
      case "B":
      case "C":
        if (!/^\d+$/.test(value!))
          throw new GrepUsageError(`invalid ${name} argument '${value!}'`);
        command.values.set(option, value!);
        return;
      case "d":
        if (value === "recurse") command.flags.add("r");
        else if (value !== "read" && value !== "skip")
          throw new GrepUsageError(`invalid ${name} argument '${value!}'`);
        return;
      case "binary-files":
        if (value === "without-match") command.flags.add("I");
        else if (value === "text") command.flags.add("a");
        else if (value !== "binary")
          throw new GrepUsageError(`invalid ${name} argument '${value!}'`);
        return;
      case "include":
        command.include.push(...expandBraces(value!));
        return;
      case "exclude":
        command.exclude.push(...expandBraces(value!));
        return;
      case "exclude-dir":
        command.excludeDir.push(...expandBraces(value!));
        return;
      case "exclude-from":
        command.exclude.push(
          ...fs
            .readFileSync(value!, "utf8")
            .split(/\r?\n/)
            .filter((line) => line.length > 0)
        );
        return;
      case "group-separator":
        command.rgOnly.push(`--context-separator=${value!}`);
        return;
      case "no-group-separator":
        command.rgOnly.push("--no-context-separator");
        return;
      case "V":
        command.info = "version";
        return;
      case "help":
        command.info = "help";
        return;
      case "D":
      case "U":
      case "noop":
      case "color":
        return;
      case "T":
      case "unsupported":
        throw new GrepUsageError(`${name} is not available in this shell`);
      default:
        if (RG_ONLY[option] != null) command.rgOnly.push(RG_ONLY[option]);
        else if (PASS_FLAGS.has(option)) command.flags.add(option);
        else throw new GrepUsageError(`invalid option -- '${option}'`);
    }
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const typed = arg.slice(2, eq < 0 ? undefined : eq);
      const exact = LONG[typed] != null ? [typed] : [];
      const matches =
        exact.length > 0
          ? exact
          : Object.keys(LONG).filter((name) => name.startsWith(typed));
      if (matches.length !== 1)
        throw new GrepUsageError(
          `${matches.length === 0 ? "unrecognized" : "ambiguous"} option '${arg}'`
        );
      const name = matches[0]!;
      const spec = LONG[name]!;
      const takesValue = spec.endsWith("=");
      // --color and --colour take an optional value.
      if (!takesValue && eq >= 0 && spec !== "color")
        throw new GrepUsageError(
          `option '--${name}' doesn't allow an argument`
        );
      let value: string | undefined;
      if (takesValue) {
        if (eq >= 0) value = arg.slice(eq + 1);
        else if (i + 1 < args.length) value = args[++i];
        else
          throw new GrepUsageError(`option '--${name}' requires an argument`);
      }
      apply(takesValue ? spec.slice(0, -1) : spec, value, `--${name}`);
      continue;
    }
    if (arg.length > 1 && arg.startsWith("-")) {
      // -NUM is -C NUM.
      const context = /^-(\d+)$/.exec(arg);
      if (context != null) {
        command.values.set("C", context[1]!);
        continue;
      }
      for (let j = 1; j < arg.length; j++) {
        const letter = arg[j]!;
        // Digits anywhere in a cluster (-n5, -5n) are -C NUM, as in GNU.
        const digits = /^\d+/.exec(arg.slice(j));
        if (digits != null) {
          command.values.set("C", digits[0]);
          j += digits[0].length - 1;
          continue;
        }
        if (!SHORT_WITH_VALUE.has(letter)) {
          apply(letter, undefined, `-${letter}`);
          continue;
        }
        let value = arg.slice(j + 1);
        if (value === "") {
          if (i + 1 >= args.length)
            throw new GrepUsageError(
              `option requires an argument -- '${letter}'`
            );
          value = args[++i]!;
        }
        apply(letter, value, `-${letter}`);
        break;
      }
      continue;
    }
    operands.push(arg);
  }

  if (!explicitPattern && command.info == null) {
    const pattern = operands.shift();
    if (pattern == null) throw new GrepUsageError("no pattern given");
    command.patterns.push(pattern);
  }
  command.files = operands;
  if (command.matcher !== "P" && command.rgOnly.length > 0)
    throw new GrepUsageError(
      "-b, -z, -Z and the group-separator options work here only with -P"
    );

  return command;
}

/** fnmatch on a base name: `*` matches a leading dot, as GNU's globs do. */
function globMatch(name: string, glob: string): boolean {
  // Node 22.5 added matchesGlob; the package allows any 22.
  if (typeof path.posix.matchesGlob !== "function")
    throw new GrepUsageError("--include and --exclude need Node 22.5 or newer");
  // The shared first character keeps matchesGlob from treating a leading dot specially.
  return path.posix.matchesGlob(`x${name}`, `x${glob}`);
}

function selected(command: GrepCommand, name: string): boolean {
  if (
    command.include.length > 0 &&
    !command.include.some((glob) => globMatch(name, glob))
  )
    return false;

  return !command.exclude.some((glob) => globMatch(name, glob));
}

function excludedDir(command: GrepCommand, name: string): boolean {
  return command.excludeDir.some((glob) => globMatch(name, glob));
}

/** GNU's rule for a directory named on the command line: excluded when the name, or any part of it after a `/`, matches. */
function excludedOperand(command: GrepCommand, operand: string): boolean {
  const suffixes = [operand];
  for (
    let at = operand.indexOf("/");
    at >= 0;
    at = operand.indexOf("/", at + 1)
  )
    suffixes.push(operand.slice(at + 1));

  // fnmatch never matches "pkg" against "pkg/"; matchesGlob would.
  return suffixes.some(
    (suffix) =>
      suffix !== "" && !suffix.endsWith("/") && excludedDir(command, suffix)
  );
}

/** GNU's wording for the errors a walk meets. */
function reason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return "No such file or directory";
  if (code === "EACCES" || code === "EPERM") return "Permission denied";

  return String(code ?? error);
}

/** What the walk found, and the errors grep would have printed. */
interface Walk {
  files: string[];
  errors: string[];
}

/**
 * The files a recursive GNU grep searches: symbolic links followed only on the
 * command line unless -R, directories skipped by --exclude-dir, files kept by
 * --include and --exclude. No operand means the working directory, shown
 * without a `./`.
 */
export function walkFiles(command: GrepCommand, cwd = process.cwd()): Walk {
  const walk: Walk = { files: [], errors: [] };
  const follow = command.flags.has("R");
  const visit = (shown: string, onCommandLine: boolean) => {
    const real = path.resolve(cwd, shown === "" ? "." : shown);
    let info: fs.Stats;
    try {
      info = onCommandLine || follow ? fs.statSync(real) : fs.lstatSync(real);
    } catch (error) {
      walk.errors.push(`${shown}: ${reason(error)}`);
      return;
    }
    const base = path.basename(real);
    if (info.isDirectory()) {
      if (
        onCommandLine
          ? shown !== "" &&
            excludedOperand(command, shown.replaceAll("\\", "/"))
          : excludedDir(command, base)
      )
        return;
      let names: string[];
      try {
        names = fs.readdirSync(real);
      } catch (error) {
        walk.errors.push(`${shown}: ${reason(error)}`);
        return;
      }
      const prefix =
        shown === "" ? "" : /[\\/]$/.test(shown) ? shown : `${shown}/`;
      for (const name of names) visit(`${prefix}${name}`, false);
      return;
    }
    if (info.isFile() && selected(command, base)) walk.files.push(shown);
  };
  for (const operand of command.files.length > 0 ? command.files : [""])
    visit(operand, true);

  return walk;
}

/** Room for file names on one BusyBox command line; Windows caps the whole line at 32,767. */
const COMMAND_LINE_BUDGET = 24_000;

function batches(files: readonly string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const file of files) {
    if (current.length > 0 && length + file.length + 3 > COMMAND_LINE_BUDGET) {
      out.push(current);
      current = [];
      length = 0;
    }
    current.push(file);
    length += file.length + 3;
  }
  if (current.length > 0) out.push(current);

  return out;
}

/** What grep writes when it refuses a command; also on stdout when stderr goes nowhere, so `2>/dev/null` cannot hide it. */
export function reportRefusal(message: string): void {
  const line = `grep: ${message}\n`;
  process.stderr.write(line);
  let discarded = false;
  try {
    // A null device is a character device that is not a terminal; the agent's own pipes are neither.
    discarded = fs.fstatSync(2).isCharacterDevice() && !tty.isatty(2);
  } catch {
    discarded = true;
  }
  // Caveat: on stdout it reaches whatever reads the pipe (`| xargs` would take it as a file name),
  // which only happens for a command that has already failed.
  if (discarded) process.stdout.write(line);
}

/** The arguments BusyBox grep gets for everything but the files. */
export function busyboxArgs(command: GrepCommand): string[] {
  const args = command.matcher === "G" ? [] : [`-${command.matcher}`];
  for (const flag of command.flags)
    if (PASS_FLAGS.has(flag)) args.push(`-${flag}`);
  for (const [letter, value] of command.values) args.push(`-${letter}`, value);
  for (const pattern of command.patterns) args.push("-e", pattern);
  for (const file of command.patternFiles) args.push("-f", file);

  return args;
}

/** The ripgrep command line for a -P search, set to search what GNU grep would. */
export function ripgrepArgs(command: GrepCommand): string[] {
  const has = (flag: string) => command.flags.has(flag);
  const recursive = has("r") || has("R");
  const args = [
    "--no-config",
    "--no-ignore",
    "--hidden",
    "--no-heading",
    "--color=never",
    // Paths as the shell spells them, never Windows' backslashes.
    "--path-separator=/",
    "--pcre2",
    has("n") ? "--line-number" : "--no-line-number",
  ];
  const map: Record<string, string[]> = {
    i: ["--ignore-case"],
    v: ["--invert-match"],
    w: ["--word-regexp"],
    x: ["--line-regexp"],
    c: ["--count", "--include-zero"],
    l: ["--files-with-matches"],
    L: ["--files-without-match"],
    o: ["--only-matching"],
    q: ["--quiet"],
    s: ["--no-messages"],
    H: ["--with-filename"],
    h: ["--no-filename"],
    a: ["--text"],
    R: ["--follow"],
  };
  for (const flag of command.flags) args.push(...(map[flag] ?? []));
  // GNU searches binary files and says "binary file matches"; ripgrep skips them unless told.
  if (!has("a") && !has("I")) args.push("--binary");
  const long: Record<string, string> = {
    m: "--max-count",
    A: "--after-context",
    B: "--before-context",
    C: "--context",
  };
  for (const [letter, value] of command.values)
    args.push(`${long[letter]!}=${value}`);
  args.push(...command.rgOnly);
  for (const glob of command.include) args.push(`--glob=${glob}`);
  for (const glob of command.exclude) args.push(`--glob=!${glob}`);
  for (const glob of command.excludeDir) args.push(`--glob=!${glob}/`);
  for (const pattern of command.patterns) args.push(`--regexp=${pattern}`);
  for (const file of command.patternFiles) args.push(`--file=${file}`);
  // Without -r, grep searches only what it is given, or stdin.
  if (!recursive) args.push("--max-depth=0");
  args.push(
    "--",
    ...(recursive || command.files.length > 0 ? command.files : ["-"])
  );

  return args;
}

/** GNU's exit status over several runs: a match wins, then an error, then none. */
function combine(statuses: readonly number[], quiet: boolean): number {
  const matched = statuses.includes(0);
  const failed = statuses.some((status) => status !== 0 && status !== 1);
  if (matched && (quiet || !failed)) return 0;

  return failed ? 2 : 1;
}

function runBusybox(args: readonly string[]): number {
  const busybox = process.env[GREP_BUSYBOX_ENV] ?? "";
  if (busybox === "") {
    reportRefusal("this shell's grep could not be found");
    return 2;
  }
  const run = spawnSync(busybox, ["grep", ...args], { stdio: "inherit" });
  if (run.error != null) {
    reportRefusal(`could not run: ${run.error.message}`);
    return 2;
  }

  return run.status ?? 2;
}

function isFile(name: string): boolean {
  try {
    return fs.statSync(name).isFile();
  } catch {
    return false;
  }
}

/** Runs one grep command line as GNU grep would; returns its exit status. */
export function grep(args: readonly string[]): number {
  let command: GrepCommand;
  try {
    command = parseGrepArgs(args);
  } catch (error) {
    reportRefusal(
      error instanceof GrepUsageError
        ? `${error.message}\nUsage: grep [OPTION]... PATTERNS [FILE]...`
        : String(error)
    );
    return 2;
  }
  if (command.info === "version") {
    process.stdout.write("grep (GNU options over BusyBox; -P by ripgrep)\n");
    return 0;
  }
  if (command.info === "help") return runBusybox(["--help"]);

  if (command.matcher === "P") {
    const rg = process.env[GREP_RG_ENV] || "rg";
    const run = spawnSync(rg, ripgrepArgs(command), { stdio: "inherit" });
    if (run.error != null) {
      reportRefusal("-P needs ripgrep (rg), which is not on PATH; use -E");
      return 2;
    }
    return run.status ?? 2;
  }

  const base = busyboxArgs(command);
  const recursive = command.flags.has("r") || command.flags.has("R");
  const selects =
    command.include.length > 0 ||
    command.exclude.length > 0 ||
    command.excludeDir.length > 0;
  // GNU names files under -r, except when the one operand is a file.
  const oneFile = command.files.length === 1 && isFile(command.files[0]!);
  const nameFlag =
    command.flags.has("h") || command.flags.has("H")
      ? []
      : oneFile
        ? ["-h"]
        : ["-H"];
  // BusyBox recurses on its own when it is given the paths and nothing to filter.
  if (!selects && (!recursive || command.files.length > 0))
    return runBusybox([
      ...base,
      ...(recursive
        ? [`-${command.flags.has("R") ? "R" : "r"}`, ...nameFlag]
        : []),
      "--",
      ...command.files,
    ]);
  // Without -r there is nothing to walk: filter the named files, or read stdin.
  if (!recursive && command.files.length === 0)
    return runBusybox([...base, "--"]);

  const walk = recursive
    ? walkFiles(command)
    : {
        files: command.files.filter(
          (file) =>
            !fs.existsSync(file) ||
            fs.statSync(file).isDirectory() ||
            selected(command, path.basename(file))
        ),
        errors: [],
      };
  const statuses: number[] = [];
  if (!command.flags.has("s"))
    for (const error of walk.errors) process.stderr.write(`grep: ${error}\n`);
  if (walk.errors.length > 0) statuses.push(2);
  const named = recursive ? nameFlag : [];
  for (const batch of batches(walk.files)) {
    statuses.push(runBusybox([...base, ...named, "--", ...batch]));
    if (statuses.at(-1) === 0 && command.flags.has("q")) break;
  }

  return combine(statuses.length > 0 ? statuses : [1], command.flags.has("q"));
}

/** The launcher's entry: `grep-shim.js grep ARGS...`. */
export function main(argv: readonly string[]): number {
  const [name, ...args] = argv;
  if (name !== "grep") {
    reportRefusal(`grep-shim: unknown command ${String(name)}`);
    return 2;
  }

  try {
    return grep(args);
  } catch (error) {
    // Anything unexpected must not read as "no match" behind 2>/dev/null.
    reportRefusal(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

// Run only as the launcher's target, never when the agent imports this file.
if (/^grep-shim\.(?:[cm]?js|ts)$/.test(path.basename(process.argv[1] ?? "")))
  process.exitCode = main(process.argv.slice(2));
