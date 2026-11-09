/**
 * What a shell command would do on this machine, read from its syntax tree
 * rather than its text. Only a word in command position is a command, so a
 * word inside quotes, a comment, a heredoc saved to a file, another
 * language's code or an ssh payload is data. One reader of shell text for
 * the permission gate and the guardrails. Anything that would run here but
 * cannot be read statically (a computed command name, a dynamic payload, a
 * script nobody can read) fails safe to the "could not read" card, never to
 * allow. An alias or function defined outside the command is not seen.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  type ArithmeticExpression,
  type Command,
  type Node,
  parse,
  type ParsedScript,
  type Redirect,
  type TestExpression,
  type Word,
  type WordPart,
} from "unbash";

import { posixShell } from "./posix-shell.js";
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
  /**
   * Which shell runs the command: the bundled POSIX shell, or cmd.exe on a
   * Windows machine without it (sandbox/mxc.ts). Defaults to what is here.
   */
  shell?: "posix" | "cmd";
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
  forcePush: "force-pushes or deletes remote git history",
  gitHistory: "deletes a whole .git folder",
  killAll: "stops every process the user is running",
  killProcess: "stops a process this run did not start",
  unreadable: "could not read this command",
  deleteRoot: "deletes the whole disk, the home folder or a folder holding it",
  emptyTrash: "empties the Trash",
  forkBomb: "is a fork bomb",
};

/** Run scripts read to see what they run: bounded size and nesting. */
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 6;

/** A word whose value is not known before the shell runs, kept as its text. */
const DYN = "\u0000";
/**
 * A program named through a variable the user's environment set, with a
 * literal file name (`"$LOCALAPPDATA/…/adb.exe"`): known by that name, its
 * folder is not. Unknown as an argument, a program in command position.
 */
const OPAQUE = "\u0002";
const isDyn = (word: string): boolean =>
  word.startsWith(DYN) || word.startsWith(OPAQUE);
const raw = (word: string): string => (isDyn(word) ? word.slice(1) : word);
/** Where a bash expansion sat in a PowerShell or cmd payload. */
const HOLE = "\u0001";

/** Content written by means the judge cannot read (a copy, a computed string). */
const UNKNOWN = Symbol("unknown content");
/** A download: running it is allowed, as `curl … | sh` is (Full access means full access). */
const REMOTE = Symbol("download");
type Content = string | typeof UNKNOWN | typeof REMOTE;

const PRIVILEGED = new Set(["sudo", "doas", "su", "pkexec", "runas", "gsudo"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash", "fish"]);
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
/** This machine by name or address: `localhost*`, 127.0.0.0/8, `0`, `::1`. */
const isLocalHost = (host: string): boolean =>
  /^(?:localhost(?:[.-][\w.-]*)?|127(?:\.\d+){0,3}|0(?:\.0+){0,3}|0x7f[\da-f]*|2130706433|\[?::1?\]?|\[?0:0:0:0:0:0:0:[01]\]?)(?::\d+)?$/i.test(
    host
  );
/** Windows delete verbs, in PowerShell and cmd. */
const WINDOWS_DELETERS = /^(?:remove-item|ri|rm|rmdir|rd|del|erase|rni)$/i;

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

/** A whole disk or partition: writing it is like `dd of=` one. */
const BLOCK_DEVICE =
  /^(?:\/dev\/(?:sd|hd|vd|xvd|nvme|mmcblk|disk|rdisk|loop|md|dm-|mapper\/|sr)|\\\\\.\\physicaldrive)/i;

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
  /** Files this command wrote earlier on, by resolved path. */
  pending: Map<string, Content>;
  /** The working folder as `cd` left it; null once a `cd` could not be read. */
  cwd: string | null;
  /** The whole command, for checks that look across it. */
  root: string;
  /**
   * Set once a command ran that may change files in ways nobody tracked (a
   * build, git, an interpreter): a script run after it may not be the one on disk.
   */
  mutated: boolean;
  /** The program the last simple command came down to, wrappers stepped over. */
  lastTool: string | null;
  /** Variables this command set: their value, or null when it cannot be read. */
  vars: Map<string, string | null>;
}

interface Scope {
  source: string;
  depth: number;
  /** Writes in a script being run are its business, not this command's. */
  collectWrites: boolean;
  /** What feeds this command's stdin, when it is a later pipeline stage. */
  stdin?: Node;
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
      shell:
        options.shell ??
        (process.platform === "win32" && posixShell() == null
          ? "cmd"
          : "posix"),
    },
    findings: [],
    writes: [],
    commands: [],
    seen: new Set(),
    pending: new Map(),
    cwd: options.cwd,
    root: command,
    mutated: false,
    lastTool: null,
    vars: new Map(),
  };

  // Unchanged rule, kept in trash.ts: it also reads scripts in other languages.
  if (emptiesTrash(command, options.cwd))
    add(context, "emptyTrash", "never", command);

  // Without the bundled shell, cmd.exe runs the line: its rules, not bash's.
  if (context.options.shell === "cmd")
    judgeWindowsShell(context, "cmd", [command], command);
  else
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

const unreadable = (context: Context, text: string): void =>
  add(context, "unreadable", "confirm", text);

/** Run `body` in a child process's view: its `cd` does not leak out. */
function isolated(context: Context, body: () => void): void {
  const cwd = context.cwd;
  body();
  context.cwd = cwd;
}

function judgeSource(context: Context, source: string, scope: Scope): void {
  if (scope.depth > MAX_DEPTH) {
    unreadable(context, source);
    return;
  }
  const script = parse(source);
  const { stdin: _stdin, ...rest } = scope;
  judgeScript(context, script, { ...rest, source });
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
      unreadable(context, source);
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
      redirects(context, node.redirects, scope, scope.source);
      walk(context, node.command, scope, seen);
      return;
    case "Command":
      seen.push(node);
      judgeSimple(context, node, scope);
      return;
    case "Pipeline":
      // Every stage after the first reads the one before it on stdin.
      node.commands.forEach((stage, index) =>
        walk(
          context,
          stage,
          index === 0 ? scope : { ...scope, stdin: node.commands[index - 1] },
          seen
        )
      );
      return;
    case "AndOr":
    case "CompoundList":
      children(node.commands);
      return;
    case "If":
      children([node.clause, node.then, node.else]);
      return;
    case "For":
    case "Select":
      // A loop over plain literal words: the variable is one of them, data
      // with no shell or PowerShell syntax in it.
      context.vars.set(
        node.name.value,
        node.wordlist.length > 0 &&
          node.wordlist.every((word) => {
            const value = sv(context, word);
            return (
              value != null &&
              !hasGlob(word) &&
              !/[\s;|&(){}$`'"<>]/.test(value)
            );
          })
          ? HOLE
          : null
      );
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
      isolated(context, () => walk(context, node.body, scope, seen));
      return;
    case "BraceGroup":
      walk(context, node.body, scope, seen);
      return;
    case "ArithmeticFor":
      for (const expression of [node.initialize, node.test, node.update])
        arithmetic(context, expression, scope);
      walk(context, node.body, scope, seen);
      return;
    case "Function":
      // A function renames commands: what a later word runs is not its name.
      unreadable(context, scope.source.slice(node.pos, node.end));
      redirects(context, node.redirects, scope, scope.source);
      walk(context, node.body, scope, seen);
      return;
    case "Coproc":
      redirects(context, node.redirects, scope, scope.source);
      walk(context, node.body, scope, seen);
      return;
    case "TestCommand":
      test(context, node.expression, scope);
      return;
    case "ArithmeticCommand":
      arithmetic(context, node.expression, scope);
      return;
    default:
      return;
  }
}

/** `[[ … ]]`: its words expand, and a `$(…)` in one runs. */
function test(
  context: Context,
  expression: TestExpression | undefined,
  scope: Scope
): void {
  if (expression == null) return;
  switch (expression.type) {
    case "TestUnary":
      expansions(context, expression.operand, scope);
      return;
    case "TestBinary":
      expansions(context, expression.left, scope);
      expansions(context, expression.right, scope);
      return;
    case "TestLogical":
      test(context, expression.left, scope);
      test(context, expression.right, scope);
      return;
    case "TestNot":
      test(context, expression.operand, scope);
      return;
    case "TestGroup":
      test(context, expression.expression, scope);
      return;
  }
}

/** `(( … ))` and `$(( … ))`: a `$(…)` inside runs. */
function arithmetic(
  context: Context,
  expression: ArithmeticExpression | undefined,
  scope: Scope
): void {
  if (expression == null) return;
  switch (expression.type) {
    case "ArithmeticBinary":
      arithmetic(context, expression.left, scope);
      arithmetic(context, expression.right, scope);
      return;
    case "ArithmeticUnary":
      arithmetic(context, expression.operand, scope);
      return;
    case "ArithmeticTernary":
      arithmetic(context, expression.test, scope);
      arithmetic(context, expression.consequent, scope);
      arithmetic(context, expression.alternate, scope);
      return;
    case "ArithmeticGroup":
      arithmetic(context, expression.expression, scope);
      return;
    case "ArithmeticWord":
      for (const part of expression.parts ?? [])
        expandPart(context, part, scope);
      return;
    case "ArithmeticCommandExpansion":
      isolated(context, () => judgeScript(context, expression.script, scope));
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
  const { stdin: _stdin, ...inner } = scope;
  switch (part.type) {
    case "CommandExpansion":
    case "ProcessSubstitution":
      isolated(context, () => judgeScript(context, part.script, inner));
      return;
    case "ArithmeticExpansion":
      arithmetic(context, part.expression, inner);
      return;
    case "DoubleQuoted":
    case "LocaleString":
      for (const child of part.parts) expandPart(context, child, scope);
      return;
    case "ParameterExpansion":
      expansions(context, part.operand, scope);
      for (const child of part.indexParts ?? [])
        expandPart(context, child, scope);
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
function staticValue(
  word: Word | undefined,
  home: string,
  pwd: string | null = null
): string | null {
  if (word == null) return null;
  const tilde = (value: string): string =>
    word.text.startsWith("~") && (value === "~" || value.startsWith("~/"))
      ? home + value.slice(1)
      : value;
  if (word.parts == null) return tilde(word.value);
  let value = "";
  for (const part of word.parts) {
    const piece = partValue(part, home, pwd);
    if (piece == null) return null;
    value += piece;
  }
  return tilde(value);
}

/** staticValue with this command's home and working folder. */
const sv = (context: Context, word: Word | undefined): string | null =>
  staticValue(word, context.options.home, context.cwd);

function partValue(
  part: WordPart,
  home: string,
  pwd: string | null
): string | null {
  switch (part.type) {
    case "Literal":
    case "SingleQuoted":
    case "AnsiCQuoted":
      return part.value;
    case "DoubleQuoted":
    case "LocaleString": {
      let value = "";
      for (const child of part.parts) {
        const piece = partValue(child, home, pwd);
        if (piece == null) return null;
        value += piece;
      }
      return value;
    }
    case "SimpleExpansion":
      return part.text === "$HOME" ? home : part.text === "$PWD" ? pwd : null;
    case "ParameterExpansion":
      if (part.operator != null || part.index != null) return null;
      return part.parameter === "HOME"
        ? home
        : part.parameter === "PWD"
          ? pwd
          : null;
    default:
      return null;
  }
}

/** An unquoted glob character the shell would expand: `*`, `?`, `[…]`. */
function hasGlob(word: Word): boolean {
  const literals =
    word.parts == null
      ? [word.text]
      : word.parts
          .filter((part) => part.type === "Literal")
          .map((part) => part.text);
  return literals.some((text) => /[*?]|\[[^\]]*\]/.test(text));
}

/** Variables a program runs or loads when set: setting one runs code nobody can read. */
const EXEC_VARIABLES = new Set([
  "BASH_ENV",
  "ENV",
  "LD_PRELOAD",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "PROMPT_COMMAND",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_EDITOR",
  "GIT_PAGER",
  "GIT_EXTERNAL_DIFF",
  "GIT_ASKPASS",
  "GIT_EXEC_PATH",
  "GIT_CONFIG_PARAMETERS",
  "SSH_ASKPASS",
  "SUDO_ASKPASS",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "MANPAGER",
  "BROWSER",
  "NODE_OPTIONS",
  "PYTHONSTARTUP",
  "PERL5OPT",
  "RUBYOPT",
]);

/**
 * The app's own Node (`$ABACUSAI_BOT_NODE`, set for every shell it runs) is
 * a known program, unless this command sets the variable itself.
 */
function appProgram(context: Context, text: string): string | null {
  if (!/^"?\$\{?ABACUSAI_BOT_NODE\}?"?$/.test(text)) return null;
  return /\bABACUSAI_BOT_NODE\s*=|\b(?:read|for|declare|typeset|local|readonly|export|unset|mapfile|readarray|printf\s+-v)\b[^\n;|&]*\bABACUSAI_BOT_NODE\b/.test(
    context.root
  )
    ? null
    : "node";
}

/** A word for the rules: its static value, or its text marked as dynamic. */
function wordValue(context: Context, word: Word): string {
  // A Windows path the model wrote unquoted keeps its backslashes as written.
  if (/^[A-Za-z]:\\/.test(word.text)) return word.text;
  const value = sv(context, word);
  if (value != null) return value;
  const named = resolveName(context, word);
  if (named == null || (named.opaque && named.name === ""))
    return DYN + word.text;
  return named.opaque ? OPAQUE + named.name : named.name;
}

/**
 * A variable the shell inherits from the app, as this process sees it; the
 * temp dir as the shell gets it where unset (posix-shell-install.ts).
 */
function inheritedValue(name: string): string | undefined {
  const found = Object.entries(process.env).find(([key]) =>
    process.platform === "win32" ? key.toUpperCase() === name : key === name
  )?.[1];
  if (found != null && found.length > 0) return found;
  return ["TMPDIR", "TMP", "TEMP"].includes(name) ? os.tmpdir() : undefined;
}

/** Programs known by name whose folder may come from the user's environment. */
const KNOWN_PROGRAM =
  /^(?:.+\.exe|python[\d.]*|pythonw|py|node|java|javaw|javac|php|ruby|perl|deno|bun|adb|fastboot|ffmpeg|ffprobe|git|npm|npx|pnpm|yarn|pip[\d.]*|uv|cargo|rustc|go|dotnet|gradle|mvn|kotlinc|sdkmanager|avdmanager|emulator|aapt2?|zipalign|apksigner|d8|keytool|jarsigner|code|magick|sqlite3|psql|mysql|curl|wget|unzip|zip|7z|tar)$/i;

/**
 * A word built from variables: those this command set to a readable value,
 * and the user's own environment (`$LOCALAPPDATA`) as an unknown folder.
 * Null when anything else feeds it (`$1`, `$@`, a variable set from `read`, a
 * value that splits into words or globs).
 */
function resolveName(
  context: Context,
  word: Word
): { name: string; opaque: boolean; value: string } | null {
  let parts = word.parts;
  if (parts == null) return null;
  if (parts.length === 1 && parts[0]!.type === "DoubleQuoted")
    parts = parts[0]!.parts;
  let value = "";
  for (const part of parts) {
    if (part.type === "Literal" || part.type === "SingleQuoted") {
      value += part.value;
      continue;
    }
    if (part.type === "DoubleQuoted") {
      const inner = part.parts.every((child) => child.type === "Literal");
      if (!inner) return null;
      value += part.parts
        .map((child) => (child as { value: string }).value)
        .join("");
      continue;
    }
    const plain =
      part.type === "SimpleExpansion" ||
      (part.type === "ParameterExpansion" &&
        part.operator == null &&
        part.index == null &&
        part.indirect !== true &&
        part.length !== true &&
        part.slice == null &&
        part.replace == null);
    if (!plain) return null;
    const name =
      part.type === "ParameterExpansion" ? part.parameter : part.text.slice(1);
    if (!/^[A-Za-z_]\w*$/.test(name)) return null;
    if (context.vars.has(name)) {
      const known = context.vars.get(name);
      if (known == null) return null;
      value += known;
    } else if (name === "HOME") value += context.options.home;
    else if (name === "PWD" && context.cwd != null) value += context.cwd;
    else if (/^[A-Z_][A-Z0-9_]*$/.test(name) && name !== "IFS")
      value += inheritedValue(name) ?? HOLE;
    else return null;
  }
  if (/[*?[]/.test(value)) return null;
  // An unquoted value splits into words; a quoted one with spaces is one name.
  const quoted = word.parts?.[0]?.type === "DoubleQuoted";
  if (/\s/.test(value) && (quoted || value.includes(HOLE))) return null;
  if (!value.includes(HOLE)) return { name: value, opaque: false, value };
  const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  const program = value.slice(slash + 1);
  if (slash <= 0 || program.includes(HOLE) || !KNOWN_PROGRAM.test(program))
    return { name: "", opaque: true, value };
  return { name: program, opaque: true, value };
}

/** Resolve a path as the shell would here; null when `cd` made it unknowable. */
function resolve(context: Context, target: string): string | null {
  if (path.isAbsolute(target) || /^[a-z]:[\\/]/i.test(target))
    return path.resolve(target);
  return context.cwd == null ? null : path.resolve(context.cwd, target);
}

function redirects(
  context: Context,
  list: readonly Redirect[],
  scope: Scope,
  text: string
): void {
  for (const redirect of list) {
    expansions(context, redirect.target, scope);
    // An unquoted heredoc expands `$(…)` here, whatever reads it.
    if (redirect.heredocQuoted !== true)
      expansions(context, redirect.body, scope);
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
    const target = sv(context, redirect.target);
    // `>&2`, `>&-`: a descriptor, not a file.
    if (target == null || /^(?:\d+|-)$/.test(target)) continue;
    addWrite(context, target, kind, scope, text);
  }
}

function addWrite(
  context: Context,
  target: string,
  kind: LocalWrite["kind"],
  scope: Scope,
  text: string
): void {
  if (target === "/dev/null" || target.length === 0 || isDyn(target)) return;
  if (BLOCK_DEVICE.test(target)) add(context, "disk", "confirm", text);
  if (!scope.collectWrites) return;
  // An unknown `cd` leaves the original folder as the best guess for the file rules.
  const resolved =
    resolve(context, target) ?? path.resolve(context.options.cwd, target);
  context.writes.push({ target, path: resolved, kind });
}

/**
 * What a command writes to its stdout, when it can be read without running
 * anything: a static `echo` or `printf`, `cat` of a heredoc, a herestring or
 * readable files, and what a pipeline stage before it produced. REMOTE for
 * a download, UNKNOWN for anything else.
 */
function producedText(
  context: Context,
  node: Node | undefined,
  scope: Scope
): Content {
  if (node?.type !== "Command" || node.name == null) return UNKNOWN;
  const name = sv(context, node.name);
  const args = node.suffix.map((word) => sv(context, word));
  if (name == null || args.some((arg) => arg == null)) return UNKNOWN;
  const words = args as string[];
  const tool = baseName(name);

  if (tool === "curl" || tool === "wget") return download(words);
  if (tool === "echo") {
    let at = 0;
    while (/^-[neE]+$/.test(words[at] ?? "")) at += 1;
    const text = words.slice(at).join(" ");
    // Some shells' echo reads backslash escapes: that is not static text.
    if (text.includes("\\")) return UNKNOWN;
    return words.slice(0, at).some((flag) => flag.includes("n"))
      ? text
      : `${text}\n`;
  }
  if (tool === "printf") {
    const [format, ...rest] = words;
    if (format == null || /\\[^nt\\]|%[^s%]/.test(format)) return UNKNOWN;
    return format
      .replace(/%s/g, () => rest.shift() ?? "")
      .replace(/%%/g, "%")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\\\/g, "\\");
  }
  if (tool === "cat") {
    const files = operandsOf(words);
    if (files.length > 0) {
      let joined = "";
      for (const file of files) {
        const content = readScript(context, file);
        if (typeof content !== "string") return content;
        joined += content;
      }
      return joined;
    }
    return stdinText(context, node, scope) ?? UNKNOWN;
  }
  return UNKNOWN;
}

/** A download from another computer over https: REMOTE; anything else is unread. */
function download(args: readonly string[]): Content {
  const url = args.find((arg) => /^https?:\/\//i.test(arg));
  const host = /^https:\/\/(?:[^@/]*@)?(\[[^\]]*\]|[^/:?#]+)/i.exec(
    url ?? ""
  )?.[1];
  return host != null && !isLocalHost(host) ? REMOTE : UNKNOWN;
}

/** What a command reads on stdin: a heredoc, a herestring, a `<` file, or the pipe. */
function stdinText(
  context: Context,
  node: Command,
  scope: Scope
): Content | null {
  for (const redirect of node.redirects) {
    if (redirect.operator === "<<<")
      return sv(context, redirect.target) ?? UNKNOWN;
    if (redirect.operator === "<<" || redirect.operator === "<<-")
      return redirect.content ?? UNKNOWN;
    if (redirect.operator === "<") {
      const file = sv(context, redirect.target);
      return file == null || context.mutated
        ? UNKNOWN
        : readScript(context, file);
    }
    // `<&3`, `<>`: a descriptor or file opened somewhere else.
    if (
      (redirect.operator === "<&" || redirect.operator === "<>") &&
      (redirect.fileDescriptor == null || redirect.fileDescriptor === 0)
    )
      return UNKNOWN;
  }
  if (scope.stdin != null)
    return producedText(context, scope.stdin, { ...scope, stdin: undefined });
  return null;
}

/**
 * Where this command's writes are remembered: the resolved path, or the
 * spelling itself when its folder comes from the environment (a HOLE).
 */
function pendingKey(context: Context, spelled: string): string | null {
  return spelled.includes(HOLE) ? spelled : resolve(context, spelled);
}

/** A script's text: what this command wrote there, or the file; UNKNOWN when neither reads. */
function readScript(context: Context, file: string): Content {
  if (isDyn(file)) return UNKNOWN;
  const resolved = resolve(context, file);
  if (resolved == null) return UNKNOWN;
  const pending = context.pending.get(resolved);
  if (pending != null) return pending;
  // Something earlier may have changed it: the file on disk is not what runs.
  if (context.mutated) return UNKNOWN;
  try {
    const info = fs.statSync(resolved);
    if (!info.isFile() || info.size > MAX_SCRIPT_BYTES) return UNKNOWN;
    return fs.readFileSync(resolved, "utf8");
  } catch {
    return UNKNOWN;
  }
}

/**
 * Remember what this command writes, so a later `bash t.sh` in the same
 * command judges it: the text of a static producer redirected or `tee`d to a
 * file, and UNKNOWN for anything else written here.
 */
function rememberWrites(
  context: Context,
  node: Command,
  scope: Scope,
  writes: readonly string[]
): void {
  const known = producedText(context, node, scope);
  const tool = baseName(sv(context, node.name) ?? "");
  const store = (target: string, content: Content, append: boolean): void => {
    const resolved = pendingKey(context, target);
    if (resolved == null) return;
    if (append && typeof content === "string") {
      const before =
        context.pending.get(resolved) ?? readScript(context, target);
      context.pending.set(
        resolved,
        typeof before === "string" ? before + content : UNKNOWN
      );
    } else context.pending.set(resolved, content);
  };
  for (const redirect of node.redirects) {
    if (![">", ">|", ">>", "&>", "&>>"].includes(redirect.operator)) continue;
    const target =
      sv(context, redirect.target) ??
      (redirect.target == null
        ? null
        : (resolveName(context, redirect.target)?.value ?? null));
    if (target == null) continue;
    store(target, known, redirect.operator.includes(">>"));
  }
  if (tool === "tee") {
    const content = stdinText(context, node, scope) ?? UNKNOWN;
    for (const target of writes) store(target, content, false);
    return;
  }
  // A download saved to a file runs as freely as one piped to a shell; any
  // other file this command writes (cp, mv, dd…) is unread.
  const other =
    tool === "curl" || tool === "wget"
      ? download(node.suffix.map((word) => sv(context, word) ?? ""))
      : UNKNOWN;
  for (const target of writes) store(target, other, false);
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
  setsid: new Set([]),
  taskset: new Set(["-c", "--cpu-list"]),
  caffeinate: new Set(["-t", "-w"]),
  chrt: new Set([]),
  flock: new Set(["-w", "-E", "--timeout", "--conflict-exit-code"]),
  watch: new Set(["-n", "--interval", "-q", "--equexit"]),
  chroot: new Set(["--userspec", "--groups"]),
  runuser: new Set(["-u", "-g", "-G", "--user", "--group", "-s", "--shell"]),
  script: new Set(["-E", "-I", "-O", "-T", "-B", "-m", "--log-io"]),
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

/**
 * Programs that change no file except where their output is redirected
 * (tracked): after only these, a script on disk is still the one read.
 */
const SAFE_TOOLS = new Set([
  "cd",
  "pushd",
  "popd",
  "echo",
  "printf",
  "cat",
  "ls",
  "dir",
  "pwd",
  "true",
  "false",
  "test",
  "[",
  "sleep",
  "export",
  "set",
  "unset",
  "shift",
  "which",
  "type",
  "command",
  "chmod",
  "mkdir",
  "date",
  "whoami",
  "id",
  "uname",
  "head",
  "tail",
  "wc",
  "grep",
  "sort",
  "uniq",
  "cut",
  "tr",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "stat",
  "file",
  "du",
  "df",
  "env",
  "printenv",
  "hostname",
  "nproc",
  "uptime",
  ":",
  // Processes and the network, not files.
  "ps",
  "tasklist",
  "taskkill",
  "kill",
  "pkill",
  "killall",
  "netstat",
  "ss",
  "lsof",
  "ping",
  "wait",
  "jobs",
  "where",
  "tput",
  "clear",
  // A download goes to stdout, or to an `-o` file this judge tracks.
  "curl",
]);

/** git subcommands that only read the repository. */
const GIT_READS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "rev-parse",
  "remote",
  "config",
  "ls-files",
  "describe",
  "tag",
  "blame",
  "grep",
  "shortlog",
  "reflog",
  "cat-file",
  "ls-remote",
]);

/** Programs that run a command line they are given, and are not stepped through. */
const OPAQUE_RUNNERS = new Set([
  "watch",
  "script",
  "sg",
  "unshare",
  "nsenter",
  "systemd-run",
  "parallel",
  "tmux",
  "screen",
  "expect",
  "at",
  "batch",
  "schtasks",
  "dbus-run-session",
  "firejail",
  "bwrap",
  "proot",
  "fakeroot",
  "torsocks",
  "proxychains",
  "proxychains4",
  "strace",
  "ltrace",
  "gdb",
  "valgrind",
  "chpst",
  "daemonize",
  "start-stop-daemon",
]);

const baseName = (word: string): string =>
  raw(word)
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.exe$/i, "")
    .toLowerCase();

function judgeSimple(context: Context, node: Command, scope: Scope): void {
  const text = scope.source.slice(node.pos, node.end);
  for (const assignment of node.prefix) {
    const value =
      assignment.array != null || assignment.append === true
        ? null
        : assignment.value == null
          ? ""
          : (sv(context, assignment.value) ??
            resolveName(context, assignment.value)?.value ??
            null);
    // A program runs this variable's value: judge it as a command line.
    if (assignment.name != null && EXEC_VARIABLES.has(assignment.name)) {
      if (value == null || value.includes(HOLE)) unreadable(context, text);
      else if (value !== "") judgeNested(context, value, scope, text);
    }
    // A bare assignment lasts for the rest of the command.
    if (assignment.name != null && node.name == null)
      context.vars.set(assignment.name, value);
    expansions(context, assignment.value, scope);
    for (const word of assignment.array ?? []) expansions(context, word, scope);
  }
  const pendingCwd = context.cwd;
  redirects(context, node.redirects, scope, text);
  const writesBefore = context.writes.length;
  expansions(context, node.name, scope);
  for (const word of node.suffix) expansions(context, word, scope);
  if (node.name == null) return;

  // Only a name written out in full is a program anyone can judge: a
  // variable, `$(…)`, `{a,b}`, `a${IFS}b` or a glob is not.
  const named = resolveName(context, node.name);
  const name =
    sv(context, node.name) ??
    appProgram(context, node.name.text) ??
    (named == null || (named.opaque && named.name === "")
      ? null
      : named.opaque
        ? OPAQUE + named.name
        : named.name);
  if (name == null || hasGlob(node.name)) {
    unreadable(context, text);
    context.mutated = true;
    return;
  }
  // `S="ssh -i k host"; $S …`: an unquoted variable splits into words.
  const split = sv(context, node.name) == null && named?.opaque === false;
  const words = [
    ...(split ? name.trim().split(/\s+/) : [name]),
    ...node.suffix.map((word) => wordValue(context, word)),
  ];
  const files = node.redirects
    .filter((redirect) => !redirect.operator.startsWith("<<"))
    .map((redirect) => sv(context, redirect.target))
    .filter(
      (target): target is string =>
        target != null && !/^(?:\d+|-)$/.test(target)
    );
  context.lastTool = null;
  judgeWords(context, words, node, text, scope, files);
  const lastTool = (context.lastTool as string | null) ?? "";
  const gitRead =
    lastTool === "git" &&
    GIT_READS.has(words.slice(1).find((word) => !word.startsWith("-")) ?? "");
  if (!SAFE_TOOLS.has(lastTool) && !gitRead) context.mutated = true;
  const cwdAfter = context.cwd;
  context.cwd = pendingCwd;
  rememberWrites(
    context,
    node,
    scope,
    context.writes
      .slice(writesBefore)
      // chmod, chown and touch leave the content as it was.
      .filter((write) => write.kind !== "meta")
      .map((write) => write.target)
  );
  context.cwd = cwdAfter;
}

/** Judge one command line from its words, stepping over wrappers. */
function judgeWords(
  context: Context,
  given: readonly string[],
  node: Command | null,
  text: string,
  scope: Scope,
  files: string[] = []
): void {
  const words = given.map((word) =>
    isDyn(word) ? (appProgram(context, raw(word)) ?? word) : word
  );
  let index = 0;
  const nested = (source: string): void =>
    judgeNested(context, source, scope, text);
  const joined = (from: number): string | null => {
    const rest = words.slice(from);
    return rest.some(isDyn) ? null : rest.join(" ");
  };
  const runString = (source: string | null | undefined): void => {
    if (source == null || isDyn(source)) unreadable(context, text);
    else nested(source);
  };

  while (index < words.length) {
    const word = words[index]!;
    // A program known by name, its folder from the environment.
    if (word.startsWith(OPAQUE)) break;
    if (isDyn(word)) {
      // A wrapper running a program named at run time.
      unreadable(context, text);
      return;
    }
    const tool = baseName(word);
    if (PRIVILEGED.has(tool)) {
      const next = skipOptions(words, index + 1, tool);
      const flags = words.slice(index + 1, next).join(" ");
      const rest = words.slice(next);
      if (tool === "sudo" && isSudoProbe(flags, rest)) return;
      add(context, "privileged", "confirm", text);
      if (tool === "su") {
        const command = optionValue(words.slice(index + 1), [
          "-c",
          "--command",
        ]);
        if (command !== undefined) runString(command);
        return;
      }
      index = next;
      continue;
    }
    if (tool === "runuser" || tool === "chroot") {
      add(context, "privileged", "confirm", text);
      const command = optionValue(words.slice(index + 1), ["-c", "--command"]);
      if (command !== undefined) {
        runString(command);
        return;
      }
      index = skipOptions(words, index + 1, tool);
      // chroot names the new root first; runuser, without -u, the user.
      if (tool === "chroot" || !words.slice(0, index).includes("-u"))
        index += 1;
      continue;
    }
    if (tool === "env") {
      // `env -S STR` splits STR into the command line.
      for (let at = index + 1; at < words.length; at += 1) {
        const flag = words[at]!;
        const inline = /^-S./.test(flag)
          ? flag.slice(2)
          : flag.startsWith("--split-string=")
            ? flag.slice("--split-string=".length)
            : null;
        if (inline == null && flag !== "-S" && flag !== "--split-string") {
          if (!flag.startsWith("-") || flag === "--") break;
          continue;
        }
        const split = inline ?? words[at + 1];
        const tail = joined(inline == null ? at + 2 : at + 1);
        runString(
          split == null || isDyn(split) || tail == null
            ? null
            : `${split} ${tail}`
        );
        return;
      }
      index = skipOptions(words, index + 1, tool);
      while (index < words.length && /^\w+=/.test(words[index]!)) index += 1;
      continue;
    }
    if (tool === "timeout") {
      index = skipOptions(words, index + 1, tool) + 1;
      continue;
    }
    if (tool === "busybox" || tool === "builtin") {
      index += 1;
      continue;
    }
    if (tool === "command") {
      // `command -v sudo` asks where sudo is; it runs nothing.
      if (/^-[a-zA-Z]*[vV]/.test(words[index + 1] ?? "")) return;
      index = skipOptions(words, index + 1, tool);
      continue;
    }
    if (tool === "flock") {
      index = skipOptions(words, index + 1, tool) + 1;
      if (words[index] === "-c" || words[index] === "--command") {
        runString(words[index + 1]);
        return;
      }
      continue;
    }
    if (tool === "wsl") {
      // The Linux side of this machine: its command is judged like any other.
      let at = index + 1;
      while (at < words.length && words[at]!.startsWith("-")) {
        const flag = words[at]!;
        if (flag === "--" || flag === "-e" || flag === "--exec") {
          at += 1;
          break;
        }
        // Root inside WSL is the Linux side's own user, not this machine's administrator.
        if (/^(?:-d|--distribution|-u|--user|--cd)$/.test(flag)) at += 2;
        else at += 1;
      }
      index = at;
      continue;
    }
    if (OPAQUE_RUNNERS.has(tool)) {
      // A runner nobody here steps through: whatever it is given runs unread.
      if (words.length > index + 1) unreadable(context, text);
      return;
    }
    if (tool === "taskset" || tool === "chrt") {
      const at = skipOptions(words, index + 1, tool);
      const flags = words.slice(index + 1, at);
      // `-p`: an existing process, nothing new runs.
      if (flags.some((flag) => /^-[a-z]*p|^--pid$/.test(flag))) return;
      const listed = flags.some((flag) => /^-[a-z]*c|^--cpu-list$/.test(flag));
      index = at + (tool === "taskset" && listed ? 0 : 1);
      continue;
    }
    if (tool === "trap") {
      const action = words[index + 1];
      if (action != null && !["-", "-l", "-p", ""].includes(action))
        runString(action);
      return;
    }
    if (
      [
        "nohup",
        "time",
        "nice",
        "exec",
        "stdbuf",
        "ionice",
        "xargs",
        "setsid",
        "caffeinate",
      ].includes(tool)
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
  context.lastTool = tool;
  context.commands.push({
    name: rest[0]!,
    args: args.map(raw),
    redirects: files,
  });

  if (
    [
      "read",
      "mapfile",
      "readarray",
      "declare",
      "typeset",
      "local",
      "export",
      "readonly",
      "unset",
      "getopts",
      "printf",
    ].includes(tool)
  ) {
    // Variables these set: a readable `export X=value` is kept, the rest unknown.
    for (const arg of args) {
      const set = /^([A-Za-z_]\w*)(?:=(.*))?$/s.exec(raw(arg));
      if (set == null || (tool === "printf" && args[0] !== "-v")) continue;
      const keep =
        ["declare", "typeset", "local", "export", "readonly"].includes(tool) &&
        set[2] != null &&
        !isDyn(arg);
      context.vars.set(set[1]!, keep ? set[2]! : null);
    }
  }
  if (tool === "cd" || tool === "pushd" || tool === "popd") {
    const target = operandsOf(args)[0];
    context.cwd =
      tool === "popd" || target === "-" || (target != null && isDyn(target))
        ? null
        : target == null
          ? context.options.home
          : resolve(context, target);
    return;
  }
  if (tool === "find") {
    judgeFind(context, args, text, scope);
    return;
  }
  if (SHELLS.has(tool)) {
    judgeShell(context, args, node, scope, text);
    return;
  }
  if (tool === "eval") {
    runString(joined(words[index + 1] === "--" ? index + 2 : index + 1));
    return;
  }
  if (tool === "source" || tool === ".") {
    judgeScriptFile(context, args[0], scope, text, "shell");
    return;
  }
  if (tool === "ssh") {
    let at = skipOptions(args, 0, "ssh");
    const host = raw(args[at] ?? "").replace(/^[^@]*@/, "");
    at += 1;
    if (args[at] === "--") at += 1;
    // Another computer's command is an argument here; this machine is not.
    if (isLocalHost(host) && args.length > at)
      runString(joined(index + 1 + at));
    return;
  }
  if (tool === "osascript") {
    if (args.some((arg) => /with\s+administrator\s+privileges/i.test(raw(arg))))
      add(context, "privileged", "confirm", text);
    return;
  }
  if (tool === "powershell" || tool === "pwsh" || tool === "cmd") {
    judgeWindowsShell(context, tool, args, text);
    return;
  }
  if (raw(rest[0]!).includes("/") && !rest[0]!.includes("\\")) {
    if (judgeScriptFile(context, rest[0], scope, text, "path")) return;
  }

  judgeVerb(context, tool, args, text, scope);
}

/**
 * The value of an option such as `-c CMD` or `--command=CMD`: undefined when
 * absent, null when it has no value.
 */
function optionValue(
  args: readonly string[],
  names: readonly string[]
): string | null | undefined {
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (names.includes(arg)) return args[at + 1] ?? null;
    for (const name of names) {
      if (name.startsWith("--") && arg.startsWith(`${name}=`))
        return arg.slice(name.length + 1);
      if (!name.startsWith("--") && arg.startsWith(name) && arg.length > 2)
        return arg.slice(name.length);
    }
  }
  return undefined;
}

/** `sudo -n true`, `sudo -n -v`, `sudo -n -l`: asks whether a password is needed. */
function isSudoProbe(flags: string, rest: readonly string[]): boolean {
  if (!/(?:^|\s)-[a-zA-Z]*n/.test(flags) && !/--non-interactive/.test(flags))
    return false;
  if (rest.length === 0) return /(?:^|\s)-[a-zA-Z]*[vlk]/.test(flags);
  return rest.length === 1 && (rest[0] === "true" || rest[0] === ":");
}

function judgeNested(
  context: Context,
  source: string,
  scope: Scope,
  text: string
): void {
  if (scope.depth >= MAX_DEPTH) {
    unreadable(context, text);
    return;
  }
  isolated(context, () =>
    judgeSource(context, source, { ...scope, depth: scope.depth + 1 })
  );
}

/** `bash -c STR`, `bash s.sh`, `bash <<EOF`, `echo … | sh`, `bash < s.sh`. */
function judgeShell(
  context: Context,
  args: readonly string[],
  node: Command | null,
  scope: Scope,
  text: string
): void {
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    // `-s`: commands come from stdin, and the words after are its arguments.
    if (/^-[a-zA-Z]*s[a-zA-Z]*$/.test(arg) && !arg.includes("c")) break;
    if (
      arg === "--" ||
      (!arg.startsWith("-") && !arg.startsWith("+")) ||
      isDyn(arg)
    ) {
      const script = arg === "--" ? args[at + 1] : arg;
      if (script != null)
        judgeScriptFile(context, script, scope, text, "shell");
      else break;
      return;
    }
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg) || arg === "--command") {
      const command = args.slice(at + 1).find((word) => !word.startsWith("-"));
      if (command == null || isDyn(command)) unreadable(context, text);
      else judgeNested(context, command, scope, text);
      return;
    }
    if (["-o", "+o", "-O", "+O", "--rcfile", "--init-file"].includes(arg))
      at += 1;
  }
  // No script named: the shell reads its commands from stdin, which must be
  // a static text or a download; anything else is unread.
  const input = node == null ? null : stdinText(context, node, scope);
  if (input === REMOTE) return;
  if (input == null || input === UNKNOWN) unreadable(context, text);
  else judgeNested(context, input, scope, text);
}

/**
 * A file this command runs, judged; true when it was handled. What this
 * command wrote there is judged as written; otherwise it must exist and be
 * read before anything untracked could have changed it. `shell` (bash x,
 * source x) is read as shell; `path` (./x) is when its first line names a
 * POSIX shell or it has no `#!` (bash runs that as shell), and another
 * interpreter or a binary is a program.
 */
function judgeScriptFile(
  context: Context,
  file: string | undefined,
  scope: Scope,
  text: string,
  mode: "shell" | "path"
): boolean {
  if (file == null) return false;
  if (scope.depth >= MAX_DEPTH) {
    unreadable(context, text);
    return true;
  }
  const resolved = isDyn(file) ? null : resolve(context, file);
  if (resolved != null && context.seen.has(resolved)) return true;
  let source = resolved == null ? UNKNOWN : context.pending.get(resolved);
  if (source == null && resolved != null) {
    // After a command that may have changed files untracked, the file on
    // disk is not necessarily what runs; one that is not there yet may be
    // written by such a command. Either way nobody can read it.
    const head = readHead(resolved);
    if (head == null) source = UNKNOWN;
    // A binary or another interpreter's script is a program, not shell.
    else if (mode === "path" && !looksLikeShell(head)) return false;
    else if (context.mutated) source = UNKNOWN;
    else source = readScript(context, file);
  }
  if (source === REMOTE) return true;
  if (source === UNKNOWN || source == null) {
    unreadable(context, text);
    return true;
  }
  if (mode === "path" && !looksLikeShell(source.slice(0, 512))) return false;
  context.seen.add(resolved!);
  isolated(context, () =>
    judgeSource(context, source, {
      ...scope,
      depth: scope.depth + 1,
      collectWrites: false,
    })
  );
  return true;
}

/** The first bytes of a file, or null when it cannot be read. */
function readHead(file: string): string | null {
  try {
    const handle = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(512);
      const length = fs.readSync(handle, buffer, 0, 512, 0);
      return buffer.subarray(0, length).toString("latin1");
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
}

/** A POSIX shell `#!`, or text with no `#!` (bash runs it as shell). */
function looksLikeShell(head: string): boolean {
  if (head.startsWith("#!"))
    return /^#!.*\b(?:ba|z|da|k|a)?sh\b/.test(head.split("\n", 1)[0]!);
  return !head.includes("\u0000") && !head.startsWith("\u007fELF");
}

/** `find P … -delete` and `find P -exec rm … {}` delete P's contents. */
function judgeFind(
  context: Context,
  args: readonly string[],
  text: string,
  scope: Scope
): void {
  const firstExpression = args.findIndex(
    (word) => word.startsWith("-") || word === "(" || word === "!"
  );
  const roots = args.slice(
    0,
    firstExpression === -1 ? undefined : firstExpression
  );
  let deletes = args.includes("-delete");
  for (let at = 0; at < args.length; at += 1) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[at]!)) continue;
    const end = args.findIndex(
      (word, position) => position > at && (word === ";" || word === "+")
    );
    const inner = args.slice(at + 1, end === -1 ? undefined : end);
    if (DELETERS.has(baseName(inner[0] ?? ""))) deletes = true;
    judgeWords(context, inner, null, text, scope);
  }
  if (deletes)
    judgeDeletes(context, roots.length > 0 ? roots : ["."], text, "find");
}

/**
 * PowerShell and cmd: other languages, read as tokens. Anything that runs a
 * computed command (`iex`, `&`, dot-sourcing, a script block, an encoded
 * command, a variable or `%VAR%` in command position) is unread; power, disk,
 * elevation and deletes of home-holding or system folders are judged.
 */
function judgeWindowsShell(
  context: Context,
  tool: string,
  args: readonly string[],
  text: string
): void {
  const words = args.map(raw);
  const powershell = tool !== "cmd";
  // `-EncodedCommand` and its short forms, with either switch prefix.
  if (
    powershell &&
    words.some((word) => /^[-/]e(?:c|n\w*)?(?::|$)/i.test(word))
  ) {
    unreadable(context, text);
    return;
  }
  // The host's own switches come first; the command follows -Command or /c.
  let at = 0;
  while (at < words.length) {
    const word = words[at]!;
    if (powershell) {
      if (/^[-/](?:c|command)$/i.test(word)) {
        at += 1;
        break;
      }
      if (/^[-/](?:f|file)$/i.test(word)) {
        // The script, as this command wrote it or as it is on disk, read
        // with the same token rules; a folder from the environment is fine.
        const file = args[at + 1];
        const spelled =
          file == null
            ? null
            : isDyn(file)
              ? bashSkeleton(context, raw(file))
              : file;
        const key = spelled == null ? null : pendingKey(context, spelled);
        let content: Content =
          key == null ? UNKNOWN : (context.pending.get(key) ?? UNKNOWN);
        if (key != null && !context.pending.has(key) && !key.includes(HOLE))
          content = readScript(context, spelled!);
        if (content === REMOTE) return;
        if (content === UNKNOWN) unreadable(context, text);
        else judgeWindowsTokens(context, true, windowsTokens(content), text);
        return;
      }
      if (
        /^[-/](?:executionpolicy|ep|ex|windowstyle|w|inputformat|if|outputformat|of|version|v|configurationname|workingdirectory|wd|settingsfile|custompipename|psconsolefile)$/i.test(
          word
        )
      )
        at += 2;
      else if (/^[-/]\w+$/.test(word)) at += 1;
      else break;
    } else {
      if (!/^\/[a-z](?::\w+)?$/i.test(word)) break;
      at += 1;
      if (/^\/[ck]$/i.test(word)) break;
    }
  }
  // The POSIX shell expands the payload first: its variables are holes the
  // rules below treat as unknown, and command output in it is unread.
  const payload: string[] = [];
  for (const arg of args.slice(at)) {
    const skeleton = isDyn(arg) ? bashSkeleton(context, raw(arg)) : raw(arg);
    if (skeleton == null) {
      unreadable(context, text);
      return;
    }
    payload.push(skeleton);
  }
  judgeWindowsTokens(
    context,
    powershell,
    windowsTokens(payload.join(" ")),
    text
  );
}

/**
 * A word the POSIX shell expands, as the text it hands on: variables this
 * command set are filled in, others become a HOLE; null for command output,
 * positional parameters, or an expansion with an operator.
 */
function bashSkeleton(context: Context, text: string): string | null {
  let body = text;
  if (body.length >= 2 && body.startsWith('"') && body.endsWith('"'))
    body = body.slice(1, -1);
  else if (/['"]/.test(body)) return null;
  // Escaped `$` and backticks are literal; restored after the scan.
  body = body
    .replace(/\\\$/g, "\u0003")
    .replace(/\\`/g, "\u0004")
    .replace(/\\(["\\])/g, "$1");
  if (/\$\(|`/.test(body)) return null;
  let readable = true;
  const filled = body.replace(
    /\$\{([^}]*)\}|\$([A-Za-z_]\w*)|\$([@*#?$!0-9-])/g,
    (match, braced?: string, simple?: string, special?: string) => {
      // Status, pid and option flags carry nothing a command chose; the
      // arguments (`$1`, `$@`) and `${x…}` forms do, or fail outright.
      if (special != null) {
        if (/^[?$!#-]$/.test(special)) return HOLE;
        readable = false;
        return match;
      }
      const name = braced ?? simple;
      if (name == null || !/^[A-Za-z_]\w*$/.test(name)) {
        // `${env:Path}` (PowerShell's) is a bad substitution: bash stops there.
        if (braced != null && /^\w+:\w+$/.test(braced)) return HOLE;
        readable = false;
        return match;
      }
      if (!context.vars.has(name))
        return /^[A-Z_][A-Z0-9_]*$/.test(name)
          ? (inheritedValue(name) ?? HOLE)
          : HOLE;
      const value = context.vars.get(name);
      if (value == null) readable = false;
      return value ?? match;
    }
  );
  return readable
    ? filled.replaceAll("\u0003", "$").replaceAll("\u0004", "`")
    : null;
}

/** Words, quoted strings kept whole, and the operators that separate statements. */
function windowsTokens(source: string): string[] {
  return (
    source.match(
      /"(?:[^"`]|`.)*"?|'[^']*'?|&&|\|\||[|&;(){}]|[^\s|&;(){}"']+/g
    ) ?? []
  );
}

const unquote = (token: string): string =>
  token.replace(/^(["'])([\s\S]*?)\1?$/, "$2");

const WINDOWS_SEPARATORS = new Set([
  "&&",
  "||",
  "|",
  "&",
  ";",
  "(",
  ")",
  "{",
  "}",
]);
const POWERSHELL_DYNAMIC =
  /^(?:iex|invoke-expression|icm|invoke-command|start-job|sajb|invoke-wmimethod|invoke-cimmethod|register-scheduledtask|start-scheduledtask)$/i;

function judgeWindowsTokens(
  context: Context,
  powershell: boolean,
  tokens: readonly string[],
  text: string
): void {
  const source = tokens.join(" ");
  if (
    powershell &&
    /\[scriptblock\]|::create\s*\(|\.invoke\s*\(/i.test(source)
  ) {
    unreadable(context, text);
    return;
  }
  const home = windowsPath(context.options.home);
  // `$py = "C:\…\python.exe"`: a variable set to a literal in this payload.
  const literals = new Set<string>();
  for (let at = 0; at + 2 < tokens.length; at += 1) {
    const end = tokens[at + 3];
    if (
      /^\$\w+$/.test(tokens[at]!) &&
      tokens[at + 1] === "=" &&
      /^(?:"[^"$`]*"|'[^']*')$/.test(tokens[at + 2]!) &&
      (end == null || WINDOWS_SEPARATORS.has(end))
    )
      literals.add(tokens[at]!.toLowerCase());
  }
  for (let at = 0; at < tokens.length; at += 1) {
    const token = unquote(tokens[at]!);
    const previous = tokens[at - 1];
    const starts =
      previous == null ||
      (WINDOWS_SEPARATORS.has(previous) && previous !== ")");
    const lower = token.toLowerCase().replace(/\.exe$/, "");

    // Another shell inside: judged by its own rules.
    if (starts && ["cmd", "powershell", "pwsh"].includes(lower)) {
      const rest = tokens.slice(at + 1).map(unquote);
      if (
        lower !== "cmd" &&
        rest.some((word) => /^[-/]e(?:c|n\w*)?(?::|$)/i.test(word))
      ) {
        unreadable(context, text);
        return;
      }
      judgeWindowsTokens(
        context,
        lower !== "cmd",
        windowsTokens(rest.join(" ")),
        text
      );
      return;
    }
    // A command named by something the POSIX shell filled in; `$x = …` and
    // `$x.Member` (what PowerShell meant) only lost their variable to it.
    if (
      starts &&
      token === HOLE &&
      !/^(?:[-+*/%]?=|\.|\[)/.test(tokens[at + 1] ?? "")
    )
      unreadable(context, text);
    else if (
      starts &&
      token !== HOLE &&
      token.includes(HOLE) &&
      !token.startsWith(`${HOLE}.`)
    )
      unreadable(context, text);
    if (powershell) {
      // The call operator, dot-sourcing, and the cmdlets that run a string.
      // `& "C:\Program Files\x.exe"` runs a program named in full; `& $x`,
      // `& { … }` and `& (…)` run something computed.
      const next = tokens[at + 1] ?? "";
      if (
        (token === "&" &&
          (next === "" ||
            (/^[$({@]/.test(unquote(next)) &&
              !literals.has(next.toLowerCase())) ||
            next.includes(HOLE))) ||
        (starts && token === ".") ||
        POWERSHELL_DYNAMIC.test(token)
      )
        unreadable(context, text);
    } else if (
      starts &&
      (/[%!]/.test(token) ||
        /^(?:call|start|for|forfiles|schtasks|at)$/i.test(token))
    ) {
      // cmd: a command named at run time, or one that runs another line.
      unreadable(context, text);
    }

    if (POWER_CMDLETS.test(token) || (starts && POWER.has(lower)))
      add(context, "power", "confirm", text);
    if (
      DISK_CMDLETS.test(token) ||
      (starts && /^(?:diskpart|format)$/i.test(lower))
    )
      add(context, "disk", "confirm", text);
    if (KILL_CMDLETS.test(token))
      add(context, "killProcess", "unattended", text);
    if (starts && /^(?:runas|gsudo|sudo)$/i.test(lower))
      add(context, "privileged", "confirm", text);

    // `-Verb RunAs` / `-Verb:RunAs`; a computed verb is unread.
    const verb = /^-verb(?::(.*))?$/i.exec(token);
    if (verb != null) {
      const value = unquote(verb[1] ?? tokens[at + 1] ?? "");
      if (/^runas$/i.test(value)) add(context, "privileged", "confirm", text);
      else if (/^[$(@%]/.test(value) || value === "" || value.includes(HOLE))
        unreadable(context, text);
    }

    if (WINDOWS_DELETERS.test(token) && (starts || previous === "|")) {
      // A delete fed by a pipe deletes whatever came down it.
      if (previous === "|") {
        unreadable(context, text);
        continue;
      }
      let index = at + 1;
      while (index < tokens.length) {
        const word = unquote(tokens[index]!);
        if (WINDOWS_SEPARATORS.has(tokens[index]!)) break;
        if (/^-\w+(?::.*)?$/.test(word) || /^\/[a-z]$/i.test(word)) {
          index += 1;
          continue;
        }
        judgeWindowsDelete(context, word, home, text);
        break;
      }
    }
  }
}

/** A path in one spelling: backslashes, lower case, no trailing `\` or `\*`. */
const windowsPath = (value: string): string => {
  let out = value.replace(/\//g, "\\").toLowerCase();
  while (/\\\*?$/.test(out) && out.length > 1 && !/^[a-z]:\\$/.test(out))
    out = out.replace(/\\\*?$/, "");
  return out;
};

function judgeWindowsDelete(
  context: Context,
  target: string,
  home: string,
  text: string
): void {
  // The home folder or drive by variable, as written.
  if (
    /^(?:~|\$home|\$env:(?:userprofile|homedrive|systemdrive|systemroot|windir)|%(?:userprofile|homedrive|systemdrive|systemroot|windir)%)(?:[\\/]\*?)?$/i.test(
      target
    )
  ) {
    add(context, "deleteRoot", "never", text);
    return;
  }
  if (/^[$(@%!]/.test(target) || target.includes(HOLE)) {
    unreadable(context, text);
    return;
  }
  const where = windowsPath(target);
  const isDrive = /^(?:[a-z]:\\?|\\)$/.test(where);
  if (
    isDrive ||
    where === home ||
    home.startsWith(`${where}\\`) ||
    /^[a-z]:\\users$/.test(where)
  )
    add(context, "deleteRoot", "never", text);
  else if (WINDOWS_SYSTEM.test(`${where}\\`))
    add(context, "systemDelete", "confirm", text);
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

  if (DELETERS.has(tool)) judgeDeletes(context, operands, text, tool);
  if (redefinesCommands(tool, args) || runsHiddenCommand(tool, args))
    unreadable(context, text);
  if (tool === "ddrescue" && BLOCK_DEVICE.test(operands[1] ?? ""))
    add(context, "disk", "confirm", text);

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
    for (const arg of args)
      if (arg.startsWith("of="))
        addWrite(context, arg.slice(3), "command", scope, text);
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

  judgeKill(context, tool, args, operands, text);

  if (tool === "git" && rewritesRemote(args))
    add(context, "forcePush", "confirm", text);

  writesOf(context, tool, args, operands, scope, text);
}

/**
 * Stopping processes. Every process the user runs (`kill -1`, a negative
 * pid, `kill 0`, `pkill -u`, `killall5`) needs a yes in every mode; one
 * process this run did not start only where nobody watches. `kill %1` and
 * `kill $!` name jobs of this command's own shell.
 */
function judgeKill(
  context: Context,
  tool: string,
  args: readonly string[],
  operands: readonly string[],
  text: string
): void {
  if (tool === "killall5") {
    add(context, "killAll", "confirm", text);
    return;
  }
  if (tool === "kill") {
    const afterDashes = args.indexOf("--");
    const negatives = args.filter(
      (arg, at) =>
        /^-\d+$/.test(arg) &&
        (at > 0 ||
          args.length === 1 ||
          (afterDashes !== -1 && at > afterDashes))
    );
    if (negatives.length > 0 || operands.some((operand) => operand === "0")) {
      add(context, "killAll", "confirm", text);
      return;
    }
    if (operands.every((operand) => OWN_SHELL_JOB.test(raw(operand)))) return;
    add(context, "killProcess", "unattended", text);
    return;
  }
  // A user's every process, or a pattern that matches every process.
  const matchesAll = (pattern: string): boolean =>
    /^(?:\^?\.[*+]?\$?|\^|\.\*|\^\.\*\$|)$/.test(pattern);
  if (
    (tool === "pkill" || tool === "killall") &&
    (args.some((arg) => /^(?:-u|-U(?!SR)|--e?uid|--user)/.test(raw(arg))) ||
      operands.some((operand) => !isDyn(operand) && matchesAll(operand)))
  ) {
    add(context, "killAll", "confirm", text);
    return;
  }
  if (
    KILLERS.has(tool) ||
    (tool === "fuser" && args.some((arg) => /^-[a-zA-Z]*k/.test(arg))) ||
    (tool === "wmic" &&
      operands.some((word) => /^process$/i.test(word)) &&
      operands.some((word) => /^(?:delete|terminate)$/i.test(word)))
  )
    add(context, "killProcess", "unattended", text);
}

/**
 * An alias, a hashed path, a loaded builtin, an exported function, or a
 * variable a program runs (`export BASH_ENV=…`): later words stop meaning
 * what they say.
 */
function redefinesCommands(tool: string, args: readonly string[]): boolean {
  switch (tool) {
    case "alias":
      return args.some((arg) => raw(arg).includes("="));
    case "hash":
      return args.some((arg) => /^-[a-z]*p/.test(arg));
    case "enable":
      return args.some((arg) => /^-[a-z]*f/.test(arg));
    case "shopt":
      return args.some((arg) => raw(arg) === "expand_aliases");
    case "export":
    case "declare":
    case "typeset":
    case "local":
    case "readonly":
      return args.some(
        (arg) =>
          /^-[a-z]*f/.test(arg) ||
          EXEC_VARIABLES.has(raw(arg).split("=")[0] ?? "")
      );
    default:
      return false;
  }
}

/**
 * A command line a known program runs that is not stepped through: `git -c
 * alias.x=!…` and friends, `npx -c`, `npm exec -c`, `wsl <command>`.
 */
function runsHiddenCommand(tool: string, args: readonly string[]): boolean {
  if (tool === "git") {
    for (let at = 0; at < args.length; at += 1) {
      const arg = raw(args[at]!);
      const setting =
        arg === "-c" || arg === "--config-env"
          ? raw(args[at + 1] ?? "")
          : arg.startsWith("--config-env=")
            ? arg.slice("--config-env=".length)
            : null;
      if (
        setting != null &&
        (setting.includes("!") ||
          /^(?:alias\.|core\.(?:sshcommand|pager|editor|hookspath|fsmonitor|askpass|gitproxy)|sequence\.editor|diff\.external|credential\.|filter\.|.*\.(?:command|cmd|textconv|helper)\b|uploadpack\.|gpg\.program|ssh\.variant)/i.test(
            setting
          ))
      )
        return true;
      if (!arg.startsWith("-")) break;
    }
    return false;
  }
  const calls = args.some((arg) => /^(?:-c|--call(?:=.*)?|--shell)$/.test(arg));
  if (["npx", "pnpx", "bunx"].includes(tool)) return calls;
  if (["npm", "pnpm", "yarn", "bun"].includes(tool))
    return ["exec", "x", "dlx"].includes(args[0] ?? "") && calls;
  return false;
}

/** Each operand a delete names: never the disk or home, a yes for system folders and .git. */
function judgeDeletes(
  context: Context,
  operands: readonly string[],
  text: string,
  tool: string
): void {
  for (const operand of operands) {
    if (isDyn(operand)) continue;
    const target = resolve(context, operand);
    if (target == null) {
      // After a `cd` nobody can read, a relative glob or `..` could be anywhere.
      if (
        /[*?[]/.test(operand) ||
        operand.split(/[\\/]/).every((s) => s === "." || s === ".." || s === "")
      )
        unreadable(context, text);
      continue;
    }
    if (isRootOrHome(operand, target, context.options.home)) {
      add(context, "deleteRoot", "never", text);
    } else if (isSystemPath(target, context.options)) {
      add(context, "systemDelete", "confirm", text);
    } else if (
      (tool === "rm" || tool === "find") &&
      path.basename(trimSlashes(target)) === ".git"
    ) {
      add(context, "gitHistory", "confirm", text);
    }
  }
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

/**
 * `/`, a drive root, the home folder or any folder holding it (`/home`,
 * `/Users`), or everything in one of them (`/*`, `~/*`, `/h*`).
 */
function isRootOrHome(operand: string, target: string, home: string): boolean {
  const homeDir = trimSlashes(home);
  const holdsHome = (dir: string): boolean =>
    dir === "/" ||
    /^[a-z]:[\\/]?$/i.test(dir) ||
    dir === homeDir ||
    homeDir.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
  if (/^[a-z]:[\\/]*\*?$/i.test(operand)) return true;
  const resolved = trimSlashes(target);
  if (holdsHome(resolved)) return true;
  // A glob: judged on the folder it expands in.
  const glob = resolved.search(/[*?[]/);
  if (glob === -1) return false;
  const parent = trimSlashes(path.dirname(resolved.slice(0, glob) + "x"));
  const leaf = path.basename(resolved);
  return (
    (holdsHome(parent) && parent !== homeDir) ||
    (parent === homeDir && /^(?:\*|\.\*|\.?\[.*\]\*?)$/.test(leaf))
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

/**
 * `git [global options] push` that rewrites or deletes remote history:
 * `--force`, `-f`, `--force-with-lease`, a `+ref`, `--mirror`, `--delete`,
 * `-d`, `--prune` or a `:ref`.
 */
function rewritesRemote(args: readonly string[]): boolean {
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
        /^--(?:force(?:-with-lease|-if-includes)?|mirror|delete|prune)(?:=|$)/.test(
          arg
        ) ||
        /^-[a-zA-Z]*[fd][a-zA-Z]*$/.test(arg) ||
        /^[+:][^\s]/.test(arg)
    );
}

/** Where a writer verb writes; a `host:path` destination is another computer. */
function writesOf(
  context: Context,
  tool: string,
  args: readonly string[],
  operands: readonly string[],
  scope: Scope,
  text: string
): void {
  const local = (operand: string): boolean =>
    !/^[^/\\:]{2,}:/.test(operand) || /^[a-z]:[\\/]/i.test(operand);
  const write = (target: string, kind: LocalWrite["kind"]): void =>
    addWrite(context, target, kind, scope, text);

  if (tool === "sed") {
    if (args.some((word) => /^-[a-zA-Z]*i/.test(word) || word === "--in-place"))
      for (const operand of operands.slice(1)) write(operand, "command");
    return;
  }
  if (WRITES_EVERY_OPERAND.has(tool)) {
    const kind = DELETERS.has(tool) ? "delete" : "command";
    for (const operand of operands) write(operand, kind);
  } else if (WRITES_METADATA.has(tool)) {
    // chmod and chown name the mode or owner first.
    for (const operand of tool === "touch" ? operands : operands.slice(1))
      write(operand, "meta");
  } else if (WRITES_LAST_OPERAND.has(tool) && operands.length > 1) {
    const last = operands[operands.length - 1]!;
    if (local(last)) write(last, "copy");
  } else if (tool === "curl" || tool === "wget") {
    const output = optionValue(
      args,
      tool === "curl" ? ["-o", "--output"] : ["-O", "--output-document"]
    );
    if (output != null) write(output, "command");
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
