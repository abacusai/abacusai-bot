/**
 * What a shell command would do on this machine, read from its syntax tree
 * rather than its text. Only a word in command position is a command, so a
 * word inside quotes, a comment, a heredoc saved to a file, another
 * language's code or an ssh payload is data. One reader of shell text for
 * the permission gate and the guardrails; deliberately syntactic, like the
 * sandbox policy: an alias or a function wrapping sudo is not seen.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  type Command,
  type Node,
  parse,
  type ParsedScript,
  type Redirect,
  type Word,
  type WordPart,
} from "unbash";

import type { GuardRule, PermissionDecision } from "./protocol.js";
import { emptiesTrash, emptyTrashMessage } from "./trash.js";

/** Actions that need the user's yes; each is lifted for a chat on its own. */
export type ConfirmRule = GuardRule;

/** Actions refused in every mode; no approval lifts them. */
export type NeverRule = "deleteRoot" | "emptyTrash" | "forkBomb";

/**
 * Actions fine with someone watching, refused where nobody is: a routine's
 * run stopping a process it did not start may be stopping the user's own.
 */
export type UnattendedRule = "killProcess";

export type Verdict = "allow" | "confirm" | "never";

export interface Finding {
  rule: ConfirmRule | NeverRule | UnattendedRule;
  tier: "confirm" | "never" | "unattended";
  /** The local command that raised it, as written. */
  command: string;
}

/** A file this command writes on this machine. */
export interface LocalWrite {
  /** As written, dequoted. */
  target: string;
  /** Resolved against the working folder, `~` and `$HOME` expanded. */
  path: string;
  /**
   * `>`, `>>`, a writer verb, a delete, a copy or move destination (which may
   * be a folder it writes into), or a verb that changes only metadata.
   */
  kind: "overwrite" | "append" | "command" | "delete" | "copy" | "meta";
}

/** One simple command this machine runs, wrappers stepped over. */
export interface LocalCommand {
  name: string;
  args: string[];
  /** Files its redirects name, read or written. */
  redirects: string[];
}

export interface Judgement {
  verdict: Verdict;
  findings: Finding[];
  localWrites: LocalWrite[];
  commands: LocalCommand[];
}

export interface JudgeOptions {
  cwd: string;
  home?: string;
  platform?: NodeJS.Platform;
}

/** What the card and the refusal say about each rule. */
export const RULE_REASONS: Record<
  ConfirmRule | NeverRule | UnattendedRule,
  string
> = {
  privileged: "runs as administrator",
  systemDelete: "deletes inside a system folder",
  disk: "erases or overwrites a disk",
  power: "shuts down or restarts the computer",
  forcePush: "force-pushes over git history",
  gitHistory: "deletes a whole .git folder",
  killProcess: "stops a process this run did not start",
  unreadable: "could not read this command",
  deleteRoot: "deletes the whole disk or home folder",
  emptyTrash: "empties the Trash",
  forkBomb: "is a fork bomb",
};

/** Run scripts read to see what they run: bounded size and nesting. */
const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_DEPTH = 3;

const PRIVILEGED = new Set(["sudo", "doas", "su", "pkexec", "runas", "gsudo"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash"]);
const POWER = new Set(["shutdown", "reboot", "halt", "poweroff"]);
const POWER_CMDLETS = /^(?:stop-computer|restart-computer)$/i;
const DISK_CMDLETS = /^(?:format-volume|clear-disk|initialize-disk)$/i;
/** Commands that stop processes by id or name, on any platform. */
const KILLERS = new Set([
  "kill",
  "pkill",
  "killall",
  "taskkill",
  "tskill",
  "xkill",
]);
const KILL_CMDLETS = /^(?:stop-process|spps|taskkill|tskill)$/i;
/** `kill` operands that can only name this command's own shell jobs. */
const OWN_SHELL_JOB = /^(?:%\d*|%[+%-]|\$!)$/;
const DELETERS = new Set(["rm", "rmdir", "shred", "unlink"]);
const LOCALHOST = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Writer verbs: every operand, or only the last. */
const WRITES_EVERY_OPERAND = new Set([
  "tee",
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "truncate",
  "mkdir",
]);
const WRITES_METADATA = new Set(["touch", "chmod", "chown"]);
const WRITES_LAST_OPERAND = new Set([
  "cp",
  "mv",
  "install",
  "ln",
  "rsync",
  "scp",
]);

/** Devices `dd of=` may write without touching a disk. */
const HARMLESS_DEVICES =
  /^\/dev\/(?:null|zero|stdout|stderr|tty|fd\/\d+|full)$/;

/** System folders: deleting inside them needs a yes. Temp folders are not. */
const SYSTEM_DIRS = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib32",
  "/lib64",
  "/proc",
  "/root",
  "/sbin",
  "/sys",
  "/usr",
  "/var/lib",
  "/var/db",
  "/System",
  "/Library",
  "/private/etc",
];
const WINDOWS_SYSTEM =
  /^[a-z]:[\\/](?:windows|program files|program files \(x86\)|programdata)(?:[\\/]|$)/i;

interface Context {
  options: Required<JudgeOptions>;
  findings: Finding[];
  writes: LocalWrite[];
  commands: LocalCommand[];
  /** Script files already read, so a script that runs itself ends. */
  seen: Set<string>;
  /** Files this same command writes from a heredoc, by resolved path. */
  pending: Map<string, string>;
}

interface Scope {
  source: string;
  depth: number;
  /** Writes in a script being run are its business, not this command's. */
  collectWrites: boolean;
}

export function judgeCommand(
  command: string,
  options: JudgeOptions
): Judgement {
  const context: Context = {
    options: {
      cwd: options.cwd,
      home: options.home ?? os.homedir(),
      platform: options.platform ?? process.platform,
    },
    findings: [],
    writes: [],
    commands: [],
    seen: new Set(),
    pending: new Map(),
  };

  // Unchanged rule, kept in trash.ts: it also reads scripts in other languages.
  if (emptiesTrash(command, options.cwd))
    add(context, "emptyTrash", "never", command);

  judgeSource(context, command, {
    source: command,
    depth: 0,
    collectWrites: true,
  });

  const verdict: Verdict = context.findings.some((f) => f.tier === "never")
    ? "never"
    : context.findings.some((f) => f.tier === "confirm")
      ? "confirm"
      : "allow";

  return {
    verdict,
    findings: context.findings,
    localWrites: context.writes,
    commands: context.commands,
  };
}

/** The confirm rules a judgement raised, once each, in order. */
export const confirmRules = (judgement: Judgement): ConfirmRule[] => [
  ...new Set(
    judgement.findings
      .filter((finding) => finding.tier === "confirm")
      .map((finding) => finding.rule as ConfirmRule)
  ),
];

/** Refusal for a `never` verdict. */
export function neverMessage(judgement: Judgement): string {
  // The Trash keeps its own wording (trash.ts), shared with the shell guard.
  if (judgement.findings.some((finding) => finding.rule === "emptyTrash"))
    return emptyTrashMessage();
  const reasons = judgement.findings
    .filter((finding) => finding.tier === "never")
    .map((finding) => RULE_REASONS[finding.rule]);
  return (
    `Refused: this command ${[...new Set(reasons)].join(" and ")}. ` +
    "That is never run by the agent, even with approval. If the user really wants it, " +
    "tell them the exact command so they can run it themselves."
  );
}

/** The rules that matter only where nobody is watching, once each. */
export const unattendedRules = (judgement: Judgement): UnattendedRule[] => [
  ...new Set(
    judgement.findings
      .filter((finding) => finding.tier === "unattended")
      .map((finding) => finding.rule as UnattendedRule)
  ),
];

/** Refusal for a judged command where nobody can answer a card. */
export function noAnswererMessage(
  rules: readonly (ConfirmRule | UnattendedRule)[]
): string {
  return (
    `This needs the user's OK (it ${rules.map((rule) => RULE_REASONS[rule]).join(" and ")}), ` +
    "and nobody can answer here. Tell them the exact command and why it is needed. " +
    "Do not rephrase the command to get past this check." +
    (rules.includes("killProcess")
      ? " To stop a background job this run started, use kill_process with its id."
      : "")
  );
}

/**
 * One line per guard verdict on stderr, which the app keeps in the agent log,
 * so verdicts and approvals can be counted without reading refusal text.
 */
export function logGuardVerdict(
  verdict: "confirm" | "never",
  rules: readonly string[],
  decided: string
): void {
  try {
    process.stderr.write(
      `guard verdict=${verdict} rule=${rules.join(",")} decided=${decided}\n`
    );
  } catch {
    // A closed log must not take the tool call with it.
  }
}

/** How a judged card was answered, for the verdict line. */
export function guardDecision(
  decision: PermissionDecision,
  verdict: { block: true } | undefined
): string {
  if (verdict?.block === true) return "rejected";
  const answer = typeof decision === "string" ? decision : decision.type;
  return answer === "allowAlways" ? "approved_chat" : "approved_once";
}

function add(
  context: Context,
  rule: ConfirmRule | NeverRule | UnattendedRule,
  tier: Finding["tier"],
  command: string
): void {
  context.findings.push({ rule, tier, command: command.trim().slice(0, 200) });
}

function judgeSource(context: Context, source: string, scope: Scope): void {
  const script = parse(source);
  judgeScript(context, script, { ...scope, source });
}

function judgeScript(
  context: Context,
  script: ParsedScript | undefined,
  scope: Scope
): void {
  if (script == null) return;
  const source = script.source ?? scope.source;
  const inner = { ...scope, source };
  const commands: Command[] = [];
  for (const statement of script.commands)
    walk(context, statement, inner, commands);

  // A parse error inside an argument leaves the command readable; anywhere
  // else nobody knows what runs, so the user decides.
  for (const error of script.errors ?? []) {
    const inArgument = commands.some((command) =>
      [...command.suffix, ...command.redirects].some(
        (part) => error.pos >= part.pos && error.pos <= part.end
      )
    );
    if (!inArgument) {
      add(context, "unreadable", "confirm", source);
      break;
    }
  }
  detectForkBomb(context, script, source);
}

function walk(
  context: Context,
  node: Node | undefined,
  scope: Scope,
  seen: Command[]
): void {
  if (node == null) return;
  const children = (nodes: readonly (Node | undefined)[]): void => {
    for (const child of nodes) walk(context, child, scope, seen);
  };
  switch (node.type) {
    case "Statement":
      redirects(context, node.redirects, scope);
      walk(context, node.command, scope, seen);
      return;
    case "Command":
      seen.push(node);
      judgeSimple(context, node, scope);
      return;
    case "Pipeline":
    case "AndOr":
    case "CompoundList":
      children(node.commands);
      return;
    case "If":
      children([node.clause, node.then, node.else]);
      return;
    case "For":
    case "Select":
      for (const word of node.wordlist) expansions(context, word, scope);
      walk(context, node.body, scope, seen);
      return;
    case "While":
      children([node.clause, node.body]);
      return;
    case "Case":
      expansions(context, node.word, scope);
      children(node.items.map((item) => item.body));
      return;
    case "Subshell":
    case "BraceGroup":
    case "ArithmeticFor":
      walk(context, node.body, scope, seen);
      return;
    case "Function":
    case "Coproc":
      redirects(context, node.redirects, scope);
      walk(context, node.body, scope, seen);
      return;
    default:
      // `[[ ]]` and `(( ))` run nothing of their own worth judging.
      return;
  }
}

/** Commands that run inside a word: `$(…)`, backticks, `<(…)`. */
function expansions(
  context: Context,
  word: Word | undefined,
  scope: Scope
): void {
  for (const part of word?.parts ?? []) expandPart(context, part, scope);
}

function expandPart(context: Context, part: WordPart, scope: Scope): void {
  switch (part.type) {
    case "CommandExpansion":
    case "ProcessSubstitution":
      judgeScript(context, part.script, scope);
      return;
    case "DoubleQuoted":
    case "LocaleString":
      for (const child of part.parts) expandPart(context, child, scope);
      return;
    case "ParameterExpansion":
      expansions(context, part.operand, scope);
      return;
    case "BraceExpansion":
    case "ExtendedGlob":
      for (const child of part.parts ?? []) expandPart(context, child, scope);
      return;
    default:
      return;
  }
}

/**
 * A word's value when it is known before the shell runs: literals and
 * quotes, a leading unquoted `~`, and `$HOME`. Null when anything else
 * expands into it.
 */
function staticValue(word: Word | undefined, home: string): string | null {
  if (word == null) return null;
  const tilde = (value: string): string =>
    word.text.startsWith("~") && (value === "~" || value.startsWith("~/"))
      ? home + value.slice(1)
      : value;
  if (word.parts == null) return tilde(word.value);
  let value = "";
  for (const part of word.parts) {
    const piece = partValue(part, home);
    if (piece == null) return null;
    value += piece;
  }
  return tilde(value);
}

function partValue(part: WordPart, home: string): string | null {
  switch (part.type) {
    case "Literal":
    case "SingleQuoted":
    case "AnsiCQuoted":
      return part.value;
    case "DoubleQuoted":
    case "LocaleString": {
      let value = "";
      for (const child of part.parts) {
        const piece = partValue(child, home);
        if (piece == null) return null;
        value += piece;
      }
      return value;
    }
    case "SimpleExpansion":
      return part.text === "$HOME" ? home : null;
    case "ParameterExpansion":
      return part.parameter === "HOME" && part.operator == null ? home : null;
    default:
      return null;
  }
}

function redirects(
  context: Context,
  list: readonly Redirect[],
  scope: Scope
): void {
  for (const redirect of list) {
    expansions(context, redirect.target, scope);
    // An unquoted heredoc expands `$(…)` here, whatever reads it.
    if (redirect.heredocQuoted !== true)
      expansions(context, redirect.body, scope);
    if (!scope.collectWrites) continue;
    const kind =
      redirect.operator === ">" ||
      redirect.operator === ">|" ||
      redirect.operator === "&>" ||
      (redirect.operator === ">&" && redirect.fileDescriptor == null)
        ? "overwrite"
        : redirect.operator === ">>" ||
            redirect.operator === "&>>" ||
            redirect.operator === "<>"
          ? "append"
          : null;
    if (kind == null) continue;
    const target = staticValue(redirect.target, context.options.home);
    // `>&2`, `>&-`: a descriptor, not a file.
    if (target == null || /^(?:\d+|-)$/.test(target)) continue;
    addWrite(context, target, kind);
  }
}

function addWrite(
  context: Context,
  target: string,
  kind: LocalWrite["kind"]
): void {
  if (target === "/dev/null" || target.length === 0) return;
  const resolved = path.resolve(context.options.cwd, target);
  context.writes.push({ target, path: resolved, kind });
}

/**
 * `cat > x.sh <<EOF … EOF; bash x.sh`: the script does not exist yet when the
 * command is judged, so what the heredoc writes is kept for judgeScriptFile.
 */
function rememberHeredocFile(context: Context, node: Command): void {
  const body = node.redirects.find(
    (r) => r.operator.startsWith("<<") && r.operator !== "<<<"
  );
  const out = node.redirects.find(
    (r) => r.operator === ">" || r.operator === ">>"
  );
  const target = staticValue(out?.target, context.options.home);
  if (body?.content == null || target == null) return;
  context.pending.set(path.resolve(context.options.cwd, target), body.content);
}

/** Options of the wrappers stepped over that take a value. */
const VALUE_OPTIONS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T"]),
  doas: new Set(["-u", "-C"]),
  pkexec: new Set(["--user"]),
  env: new Set(["-u", "-C", "--unset", "--chdir"]),
  nice: new Set(["-n", "--adjustment"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  exec: new Set(["-a"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  ionice: new Set(["-c", "-n", "-p"]),
  xargs: new Set(["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a"]),
  ssh: new Set(
    "-b -c -D -E -e -F -I -i -J -L -l -m -O -o -p -Q -R -S -W -w".split(" ")
  ),
};

/** Index of the first word after a wrapper's own options. */
function skipOptions(words: readonly string[], from: number, tool: string) {
  const takesValue = VALUE_OPTIONS[tool] ?? new Set<string>();
  let index = from;
  while (index < words.length) {
    const word = words[index]!;
    if (word === "--") return index + 1;
    if (!word.startsWith("-") || word === "-") break;
    index += takesValue.has(word) ? 2 : 1;
  }
  return index;
}

const baseName = (word: string): string =>
  word
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.exe$/i, "")
    .toLowerCase();

function judgeSimple(context: Context, node: Command, scope: Scope): void {
  for (const assignment of node.prefix) {
    expansions(context, assignment.value, scope);
    for (const word of assignment.array ?? []) expansions(context, word, scope);
  }
  redirects(context, node.redirects, scope);
  rememberHeredocFile(context, node);
  expansions(context, node.name, scope);
  for (const word of node.suffix) expansions(context, word, scope);
  if (node.name == null) return;

  const text = scope.source.slice(node.pos, node.end);
  const home = context.options.home;
  const name = staticValue(node.name, home);
  if (name == null) {
    // `$(echo sudo) …` names its command at run time; `$SSH …` is a variable
    // the user's own script set, judged as an unknown command.
    if (node.name.parts?.some((part) => part.type === "CommandExpansion"))
      add(context, "unreadable", "confirm", text);
    return;
  }
  // An argument that is not static stays in place as its raw text: what it
  // expands to is unknown, which no rule below reads as a match.
  // A Windows path the model wrote unquoted keeps its backslashes as written.
  const words = [
    name,
    ...node.suffix.map((word) =>
      /^[A-Za-z]:\\/.test(word.text)
        ? word.text
        : (staticValue(word, home) ?? word.text)
    ),
  ];
  const files = node.redirects
    .filter((redirect) => !redirect.operator.startsWith("<<"))
    .map((redirect) => staticValue(redirect.target, home))
    .filter(
      (target): target is string =>
        target != null && !/^(?:\d+|-)$/.test(target)
    );
  judgeWords(context, words, node, text, scope, files);
}

/** Judge one command line from its words, stepping over wrappers. */
function judgeWords(
  context: Context,
  words: readonly string[],
  node: Command | null,
  text: string,
  scope: Scope,
  files: string[] = []
): void {
  let index = 0;

  while (index < words.length) {
    const tool = baseName(words[index]!);
    if (PRIVILEGED.has(tool)) {
      const next = skipOptions(words, index + 1, tool);
      const flags = words.slice(index + 1, next).join(" ");
      const rest = words.slice(next);
      if (tool === "sudo" && isSudoProbe(flags, rest)) return;
      add(context, "privileged", "confirm", text);
      if (tool === "su") {
        const command = suCommand(words.slice(index + 1));
        if (command != null) judgeNested(context, command, scope);
        return;
      }
      index = next;
      continue;
    }
    if (tool === "env") {
      index = skipOptions(words, index + 1, tool);
      while (index < words.length && /^\w+=/.test(words[index]!)) index += 1;
      continue;
    }
    if (tool === "timeout") {
      index = skipOptions(words, index + 1, tool) + 1;
      continue;
    }
    if (tool === "busybox") {
      index += 1;
      continue;
    }
    if (tool === "command") {
      // `command -v sudo` asks where sudo is; it runs nothing.
      if (/^-[a-zA-Z]*[vV]/.test(words[index + 1] ?? "")) return;
      index = skipOptions(words, index + 1, tool);
      continue;
    }
    if (
      ["nohup", "time", "nice", "exec", "stdbuf", "ionice", "xargs"].includes(
        tool
      )
    ) {
      index = skipOptions(words, index + 1, tool);
      continue;
    }
    break;
  }

  const rest = words.slice(index);
  if (rest.length === 0) return;
  const tool = baseName(rest[0]!);
  const args = rest.slice(1);
  context.commands.push({ name: rest[0]!, args, redirects: files });

  if (tool === "find") {
    for (let at = 0; at < args.length; at += 1) {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[at]!)) continue;
      const end = args.findIndex(
        (word, position) => position > at && (word === ";" || word === "+")
      );
      const inner = args.slice(at + 1, end === -1 ? undefined : end);
      judgeWords(context, inner, null, inner.join(" "), scope);
    }
    return;
  }
  if (SHELLS.has(tool)) {
    judgeShell(context, args, node, scope);
    return;
  }
  if (tool === "eval" || tool === "source" || tool === ".") {
    if (tool === "eval") judgeNested(context, args.join(" "), scope);
    else if (args[0] != null) judgeScriptFile(context, args[0], scope);
    return;
  }
  if (tool === "ssh") {
    const at = skipOptions(args, 0, "ssh");
    const host = (args[at] ?? "").replace(/^[^@]*@/, "");
    // Another computer's command is an argument here; this machine is not.
    if (LOCALHOST.has(host) && args.length > at + 1)
      judgeNested(context, args.slice(at + 1).join(" "), scope);
    return;
  }
  if (tool === "powershell" || tool === "pwsh" || tool === "cmd") {
    // Another language: only its power and disk commands are looked for.
    for (const word of args.flatMap((arg) => arg.split(/[\s;|&()]+/))) {
      if (
        POWER_CMDLETS.test(word) ||
        (tool === "cmd" && POWER.has(word.toLowerCase()))
      )
        add(context, "power", "confirm", text);
      if (DISK_CMDLETS.test(word)) add(context, "disk", "confirm", text);
      if (KILL_CMDLETS.test(word))
        add(context, "killProcess", "unattended", text);
    }
    return;
  }
  if (rest[0]!.includes("/") && !rest[0]!.includes("\\")) {
    if (judgeScriptFile(context, rest[0]!, scope, true)) return;
  }

  judgeVerb(context, tool, args, text, scope);
}

/** `sudo -n true`, `sudo -n -v`, `sudo -n -l`: asks whether a password is needed. */
function isSudoProbe(flags: string, rest: readonly string[]): boolean {
  if (!/(?:^|\s)-[a-zA-Z]*n/.test(flags) && !/--non-interactive/.test(flags))
    return false;
  if (rest.length === 0) return /(?:^|\s)-[a-zA-Z]*[vlk]/.test(flags);
  return rest.length === 1 && (rest[0] === "true" || rest[0] === ":");
}

function suCommand(args: readonly string[]): string | null {
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (arg === "-c" || arg === "--command") return args[at + 1] ?? null;
    if (arg.startsWith("--command=")) return arg.slice("--command=".length);
  }
  return null;
}

function judgeNested(context: Context, source: string, scope: Scope): void {
  if (scope.depth >= MAX_DEPTH + 3) {
    add(context, "unreadable", "confirm", source);
    return;
  }
  judgeSource(context, source, { ...scope, depth: scope.depth + 1 });
}

/** `bash -c STR`, `bash <<EOF`, `sh -s <<<STR`, `bash x.sh`. */
function judgeShell(
  context: Context,
  args: readonly string[],
  node: Command | null,
  scope: Scope
): void {
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (arg === "--") break;
    if (!arg.startsWith("-") && !arg.startsWith("+")) {
      judgeScriptFile(context, arg, scope);
      return;
    }
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) {
      const command = args.slice(at + 1).find((word) => !word.startsWith("-"));
      if (command != null) judgeNested(context, command, scope);
      return;
    }
    if (arg === "-o" || arg === "+o" || arg === "-O" || arg === "+O") at += 1;
  }
  // No script named: the shell reads its commands from stdin.
  for (const redirect of node?.redirects ?? []) {
    if (["<<", "<<-", "<<<"].includes(redirect.operator)) {
      const body =
        redirect.operator === "<<<"
          ? staticValue(redirect.target, context.options.home)
          : redirect.content;
      if (body != null) judgeNested(context, body, scope);
    }
  }
}

/**
 * A local script this command runs, read and judged; true when one was. Only
 * files inside the workspace or temp, small, and nested at most a few deep.
 * `requireShebang`: a bare `./x` runs as shell only when it says so.
 */
function judgeScriptFile(
  context: Context,
  file: string,
  scope: Scope,
  requireShebang = false
): boolean {
  const resolved = path.resolve(context.options.cwd, file);
  if (scope.depth >= MAX_DEPTH || context.seen.has(resolved)) return false;
  const inside = [context.options.cwd, os.tmpdir()].some((root) => {
    const relative = path.relative(root, resolved);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  });
  if (!inside) return false;
  let source = context.pending.get(resolved);
  if (source == null) {
    try {
      const info = fs.statSync(resolved);
      if (!info.isFile() || info.size > MAX_SCRIPT_BYTES) return false;
      source = fs.readFileSync(resolved, "utf8");
    } catch {
      return false;
    }
  }
  if (
    requireShebang &&
    !/^#!.*\b(?:ba|z|da|k|a)?sh\b/.test(source.split("\n", 1)[0] ?? "")
  )
    return false;
  context.seen.add(resolved);
  judgeSource(context, source, {
    ...scope,
    depth: scope.depth + 1,
    collectWrites: false,
  });
  return true;
}

/** The command itself, wrappers and nested shells already stepped over. */
function judgeVerb(
  context: Context,
  tool: string,
  args: readonly string[],
  text: string,
  scope: Scope
): void {
  const operands = operandsOf(args);

  if (DELETERS.has(tool)) {
    for (const operand of operands) {
      const target = path.resolve(context.options.cwd, operand);
      if (isRootOrHome(operand, target, context.options.home)) {
        add(context, "deleteRoot", "never", text);
      } else if (isSystemPath(target, context.options)) {
        add(context, "systemDelete", "confirm", text);
      } else if (
        tool === "rm" &&
        path.basename(trimSlashes(operand)) === ".git"
      ) {
        add(context, "gitHistory", "confirm", text);
      }
    }
  }

  if (/^(?:mkfs(?:\..+)?|mke2fs|newfs(?:_.+)?|wipefs)$/.test(tool))
    add(context, "disk", "confirm", text);
  if (
    tool === "diskutil" &&
    /^(?:erase|zero|randomdisk|secureerase|partitiondisk)/i.test(
      operands[0] ?? ""
    )
  )
    add(context, "disk", "confirm", text);
  if (tool === "format" && /^[a-z]:$/i.test(operands[0] ?? ""))
    add(context, "disk", "confirm", text);
  if (tool === "dd") {
    for (const arg of args) {
      if (!arg.startsWith("of=")) continue;
      const target = arg.slice(3);
      if (target.startsWith("/dev/") && !HARMLESS_DEVICES.test(target))
        add(context, "disk", "confirm", text);
      else if (scope.collectWrites) addWrite(context, target, "command");
    }
  }

  if (POWER.has(tool) || POWER_CMDLETS.test(tool))
    add(context, "power", "confirm", text);
  if (
    tool === "systemctl" &&
    operands.some((word) => /^(?:reboot|poweroff|halt|kexec)$/.test(word))
  )
    add(context, "power", "confirm", text);
  if (
    (tool === "init" || tool === "telinit") &&
    /^[06]$/.test(operands[0] ?? "")
  )
    add(context, "power", "confirm", text);

  // A server or app may be the user's own: `kill %1` and `kill $!` name only
  // jobs of this command's shell; `kill -l` lists signals.
  if (
    (KILLERS.has(tool) &&
      !(
        tool === "kill" &&
        operands.every((operand) => OWN_SHELL_JOB.test(operand))
      )) ||
    (tool === "fuser" && args.some((arg) => /^-[a-zA-Z]*k/.test(arg))) ||
    (tool === "wmic" &&
      operands.some((word) => /^process$/i.test(word)) &&
      operands.some((word) => /^(?:delete|terminate)$/i.test(word)))
  )
    add(context, "killProcess", "unattended", text);

  if (tool === "git" && isForcePush(args))
    add(context, "forcePush", "confirm", text);

  if (scope.collectWrites) writesOf(context, tool, args, operands);
}

/** Non-option words, honouring `--`. */
function operandsOf(args: readonly string[]): string[] {
  const operands: string[] = [];
  let options = true;
  for (const arg of args) {
    if (options && arg === "--") options = false;
    else if (!options || !arg.startsWith("-") || arg === "-")
      operands.push(arg);
  }
  return operands;
}

/** A path without trailing slashes; a loop, as a regex would be quadratic on a run of them. */
function trimSlashes(value: string): string {
  let end = value.length;
  while (end > 1 && (value[end - 1] === "/" || value[end - 1] === "\\"))
    end -= 1;
  return value.slice(0, end) || "/";
}

/** `/`, a drive root, the home folder itself, or everything in one of them. */
function isRootOrHome(operand: string, target: string, home: string): boolean {
  const top = (value: string): boolean =>
    value === "/" || value === trimSlashes(home) || /^[a-z]:$/i.test(value);
  if (/^[a-z]:[\\/]*\*?$/i.test(operand)) return true;
  if (top(trimSlashes(target))) return true;
  return (
    path.basename(target) === "*" && top(trimSlashes(path.dirname(target)))
  );
}

/** A system folder, unless it is the workspace the user pointed the agent at. */
function isSystemPath(
  target: string,
  options: Required<JudgeOptions>
): boolean {
  const within = (dir: string): boolean =>
    target === dir || target.startsWith(`${dir}/`);
  if (within(path.resolve(options.cwd))) return false;
  if (WINDOWS_SYSTEM.test(target)) return true;
  if (options.platform === "win32") return false;
  return SYSTEM_DIRS.some(within);
}

/** `git [global options] push` with `--force`, `-f`, `--force-with-lease` or `+ref`. */
function isForcePush(args: readonly string[]): boolean {
  let at = 0;
  while (at < args.length && args[at]!.startsWith("-")) {
    at += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(
      args[at]!
    )
      ? 2
      : 1;
  }
  if (args[at] !== "push") return false;
  return args
    .slice(at + 1)
    .some(
      (arg) =>
        /^--force(?:-with-lease|-if-includes)?(?:=|$)/.test(arg) ||
        /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg) ||
        /^\+[^\s]/.test(arg)
    );
}

/** Where a writer verb writes; a `host:path` destination is another computer. */
function writesOf(
  context: Context,
  tool: string,
  args: readonly string[],
  operands: readonly string[]
): void {
  const local = (operand: string): boolean =>
    !/^[^/\\:]{2,}:/.test(operand) || /^[a-z]:[\\/]/i.test(operand);

  if (tool === "sed") {
    if (args.some((word) => /^-[a-zA-Z]*i/.test(word) || word === "--in-place"))
      for (const operand of operands.slice(1))
        addWrite(context, operand, "command");
    return;
  }
  if (WRITES_EVERY_OPERAND.has(tool)) {
    const kind = DELETERS.has(tool) ? "delete" : "command";
    for (const operand of operands) addWrite(context, operand, kind);
  } else if (WRITES_METADATA.has(tool)) {
    // chmod and chown name the mode or owner first.
    for (const operand of tool === "touch" ? operands : operands.slice(1))
      addWrite(context, operand, "meta");
  } else if (WRITES_LAST_OPERAND.has(tool) && operands.length > 1) {
    const last = operands[operands.length - 1]!;
    if (local(last)) addWrite(context, last, "copy");
  }
}

/** `:(){ :|:& };:` and its renamings: a function that starts copies of itself. */
function detectForkBomb(
  context: Context,
  script: ParsedScript,
  source: string
): void {
  const names = (node: Node | undefined): string[] => {
    if (node?.type === "Command") return [node.name?.value ?? ""];
    if (node?.type === "Pipeline") return node.commands.flatMap(names);
    return [];
  };
  // Whether `name` runs itself in a pipeline or in the background.
  const spawnsItself = (node: Node | undefined, name: string): boolean => {
    if (node == null) return false;
    switch (node.type) {
      case "Statement":
        if (node.background === true && names(node.command).includes(name))
          return true;
        return spawnsItself(node.command, name);
      case "Pipeline":
        return (
          names(node).includes(name) ||
          node.commands.some((child) => spawnsItself(child, name))
        );
      case "AndOr":
      case "CompoundList":
        return node.commands.some((child) => spawnsItself(child, name));
      case "Subshell":
      case "BraceGroup":
        return spawnsItself(node.body, name);
      default:
        return false;
    }
  };
  const visit = (node: Node | undefined): void => {
    if (node == null) return;
    if (node.type === "Function") {
      if (spawnsItself(node.body, node.name.value))
        add(context, "forkBomb", "never", source);
      return;
    }
    if (node.type === "Statement") visit(node.command);
    else if (
      node.type === "Pipeline" ||
      node.type === "AndOr" ||
      node.type === "CompoundList"
    )
      node.commands.forEach(visit);
    else if (node.type === "Subshell" || node.type === "BraceGroup")
      visit(node.body);
  };
  script.commands.forEach(visit);
}
