/**
 * What a shell command would do on this machine, read from its syntax tree
 * rather than its text. Only a word in command position is a command, so a
 * word inside quotes, a comment, a heredoc saved to a file, another
 * language's code or an ssh payload is data. One reader of shell text for
 * the permission gate and the guardrails. A mistake-catcher, not a sandbox:
 * it flags a short list of dangerous commands it can read, and lets through
 * whatever it cannot read.
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

export type Verdict = "allow" | "confirm" | "never";

export interface Finding {
  rule: ConfirmRule | NeverRule;
  tier: "confirm" | "never";
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
export const RULE_REASONS: Record<ConfirmRule | NeverRule, string> = {
  privileged: "runs as administrator",
  systemDelete: "deletes inside a system folder",
  disk: "erases or overwrites a disk",
  power: "shuts down or restarts the computer",
  forcePush: "force-pushes or deletes remote git history",
  killAll: "stops every process the user is running",
  deleteRoot: "deletes the whole disk, the home folder or a folder holding it",
  emptyTrash: "empties the Trash",
  forkBomb: "is a fork bomb",
};

/** Run scripts read to see what they run: bounded size and nesting. */
const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_DEPTH = 6;

/** A word whose value is not known before the shell runs, kept as its text. */
const DYN = "\u0000";
const isDyn = (word: string): boolean => word.startsWith(DYN);
const raw = (word: string): string => (isDyn(word) ? word.slice(1) : word);

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
const DELETERS = new Set(["rm", "rmdir", "shred", "unlink"]);
/** This machine by name or address: `localhost*`, 127.0.0.0/8, `0`, `::1`. */
const isLocalHost = (host: string): boolean =>
  /^(?:localhost(?:[.-][\w.-]*)?|127(?:\.\d+){0,3}|0(?:\.0+){0,3}|\[?::1\]?)(?::\d+)?$/i.test(
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

/**
 * What a run nobody watches is told after a command the user would have been
 * asked about ran anyway: nothing is refused, and the report says so.
 */
export function unattendedNote(rules: readonly ConfirmRule[]): string {
  return (
    `Nobody was there to approve this command, so it ran without a yes (it ${rules.map((rule) => RULE_REASONS[rule]).join(" and ")}). ` +
    "Say in your report that you ran it, and why."
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
  rule: ConfirmRule | NeverRule,
  tier: Finding["tier"],
  command: string
): void {
  context.findings.push({ rule, tier, command: command.trim().slice(0, 200) });
}

/** Run `body` in a child process's view: its `cd` does not leak out. */
function isolated(context: Context, body: () => void): void {
  const cwd = context.cwd;
  body();
  context.cwd = cwd;
}

function judgeSource(context: Context, source: string, scope: Scope): void {
  if (scope.depth > MAX_DEPTH) return;
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
  // What parsed is judged; what did not is let through.
  for (const statement of script.commands)
    walk(context, statement, inner, commands);
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

/**
 * `"$VENV/bin/python"`: a variable only in the folder, so the program is
 * known by its last path segment. A shell script run that way is not, so its
 * name stays unknown.
 */
function knownProgram(word: Word): string | null {
  const parts =
    word.parts?.length === 1 && word.parts[0]!.type === "DoubleQuoted"
      ? word.parts[0]!.parts
      : word.parts;
  if (parts == null) return null;
  const last = parts.at(-1);
  if (last?.type !== "Literal" || !last.value.includes("/")) return null;
  const plain = parts
    .slice(0, -1)
    .every(
      (part) =>
        part.type === "Literal" ||
        part.type === "SimpleExpansion" ||
        (part.type === "ParameterExpansion" && part.operator == null)
    );
  const program = last.value.slice(last.value.lastIndexOf("/") + 1);
  return plain && program !== "" && !/\.(?:sh|bash|zsh)$/i.test(program)
    ? program
    : null;
}

/** A word for the rules: its static value, or its text marked as dynamic. */
function wordValue(word: Word, home: string): string {
  // A Windows path the model wrote unquoted keeps its backslashes as written.
  if (/^[A-Za-z]:\\/.test(word.text)) return word.text;
  return staticValue(word, home) ?? DYN + word.text;
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
    const target = staticValue(redirect.target, context.options.home);
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
  const home = context.options.home;
  const name = staticValue(node.name, home);
  const args = node.suffix.map((word) => staticValue(word, home));
  if (name == null || args.some((arg) => arg == null)) return UNKNOWN;
  const words = args as string[];
  const tool = baseName(name);

  if (tool === "curl" || tool === "wget") return REMOTE;
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

/** What a command reads on stdin: a heredoc, a herestring, a `<` file, or the pipe. */
function stdinText(
  context: Context,
  node: Command,
  scope: Scope
): Content | null {
  for (const redirect of node.redirects) {
    if (redirect.operator === "<<<")
      return staticValue(redirect.target, context.options.home) ?? UNKNOWN;
    if (redirect.operator === "<<" || redirect.operator === "<<-")
      return redirect.content ?? UNKNOWN;
    if (redirect.operator === "<") {
      const file = staticValue(redirect.target, context.options.home);
      return file == null ? UNKNOWN : readScript(context, file);
    }
  }
  if (scope.stdin != null)
    return producedText(context, scope.stdin, { ...scope, stdin: undefined });
  return null;
}

/** A script's text: what this command wrote there, or the file; UNKNOWN when neither reads. */
function readScript(context: Context, file: string): Content {
  if (isDyn(file)) return UNKNOWN;
  const resolved = resolve(context, file);
  if (resolved == null) return UNKNOWN;
  const pending = context.pending.get(resolved);
  if (pending != null) return pending;
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
  const home = context.options.home;
  const known = producedText(context, node, scope);
  const tool = baseName(staticValue(node.name, home) ?? "");
  const store = (target: string, content: Content, append: boolean): void => {
    const resolved = resolve(context, target);
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
    const target = staticValue(redirect.target, home);
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
  const other = tool === "curl" || tool === "wget" ? REMOTE : UNKNOWN;
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
  flock: new Set(["-w", "-E", "--timeout", "--conflict-exit-code"]),
  watch: new Set(["-n", "--interval", "-q", "--equexit"]),
  chroot: new Set(["--userspec", "--groups"]),
  runuser: new Set(["-u", "-g", "-G", "--user", "--group", "-s", "--shell"]),
  script: new Set(["-E", "-I", "-O", "-T", "-B", "-m", "--log-io"]),
  ssh: new Set(
    "-b -c -D -E -e -F -I -i -J -L -l -m -O -o -p -Q -R -S -W -w".split(" ")
  ),
};

/** `-xyz` holding the letter: a short-flag cluster, read without a backtracking regex. */
const isFlagWith = (arg: string, letter: string): boolean =>
  /^-[a-zA-Z]+$/.test(arg) && arg.includes(letter);

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
  raw(word)
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.exe$/i, "")
    .toLowerCase();

function judgeSimple(context: Context, node: Command, scope: Scope): void {
  const text = scope.source.slice(node.pos, node.end);
  for (const assignment of node.prefix) {
    expansions(context, assignment.value, scope);
    for (const word of assignment.array ?? []) expansions(context, word, scope);
  }
  const pendingCwd = context.cwd;
  redirects(context, node.redirects, scope, text);
  const writesBefore = context.writes.length;
  expansions(context, node.name, scope);
  for (const word of node.suffix) expansions(context, word, scope);
  if (node.name == null) return;

  const home = context.options.home;
  const name = staticValue(node.name, home) ?? knownProgram(node.name);
  // A computed name (`$X`, `$(…)`, `{a,b}`, a glob) is not judged.
  if (name == null || hasGlob(node.name)) return;
  const words = [name, ...node.suffix.map((word) => wordValue(word, home))];
  const files = node.redirects
    .filter((redirect) => !redirect.operator.startsWith("<<"))
    .map((redirect) => staticValue(redirect.target, home))
    .filter(
      (target): target is string =>
        target != null && !/^(?:\d+|-)$/.test(target)
    );
  judgeWords(context, words, node, text, scope, files);
  const cwdAfter = context.cwd;
  context.cwd = pendingCwd;
  rememberWrites(
    context,
    node,
    scope,
    context.writes.slice(writesBefore).map((write) => write.target)
  );
  context.cwd = cwdAfter;
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
  const nested = (source: string): void => judgeNested(context, source, scope);
  const joined = (from: number): string | null => {
    const rest = words.slice(from);
    return rest.some(isDyn) ? null : rest.join(" ");
  };
  const runString = (source: string | null | undefined): void => {
    if (source != null && !isDyn(source)) nested(source);
  };

  while (index < words.length) {
    const word = words[index]!;
    // A program named at run time is not judged.
    if (isDyn(word)) return;
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
    if (tool === "watch") {
      const at = skipOptions(words, index + 1, tool);
      const execs = words
        .slice(index + 1, at)
        .some((flag) => /^-[a-z]*x|^--exec$/.test(flag));
      if (execs) {
        index = at;
        continue;
      }
      // watch hands its words to `sh -c`.
      runString(joined(at));
      return;
    }
    if (tool === "script") {
      const command = optionValue(words.slice(index + 1), ["-c", "--command"]);
      if (command !== undefined) runString(command);
      return;
    }
    if (tool === "sg") {
      const rest = words.slice(index + 2);
      const command = rest[0] === "-c" ? rest[1] : joined(index + 2);
      if (rest.length > 0) runString(command);
      return;
    }
    if (tool === "taskset" || tool === "chrt") {
      const at = skipOptions(words, index + 1, tool);
      const flags = words.slice(index + 1, at);
      // `-p`: an existing process, nothing new runs.
      if (flags.some((flag) => isFlagWith(flag, "p") || flag === "--pid"))
        return;
      const listed = flags.some(
        (flag) => isFlagWith(flag, "c") || flag === "--cpu-list"
      );
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
  context.commands.push({
    name: rest[0]!,
    args: args.map(raw),
    redirects: files,
  });

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
    runString(joined(index + 1));
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

function judgeNested(context: Context, source: string, scope: Scope): void {
  if (scope.depth >= MAX_DEPTH) return;
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
    if (isFlagWith(arg, "s") && !arg.includes("c")) break;
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
    if (isFlagWith(arg, "c") || arg === "--command") {
      const command = args.slice(at + 1).find((word) => !word.startsWith("-"));
      if (command != null && !isDyn(command))
        judgeNested(context, command, scope);
      return;
    }
    if (["-o", "+o", "-O", "+O", "--rcfile", "--init-file"].includes(arg))
      at += 1;
  }
  // No script named: the shell reads its commands from stdin.
  if (node == null) return;
  const input = stdinText(context, node, scope);
  if (typeof input === "string") judgeNested(context, input, scope);
}

/**
 * A script this command runs as shell, judged when it can be read; true when
 * it was handled. `shell` (bash x, source x) is read as shell; `path` (./x)
 * is when its first line names a POSIX shell or it has no `#!` (bash runs
 * that as shell). A binary, another interpreter or a missing file is not.
 */
function judgeScriptFile(
  context: Context,
  file: string | undefined,
  scope: Scope,
  text: string,
  mode: "shell" | "path"
): boolean {
  if (file == null) return false;
  if (scope.depth >= MAX_DEPTH) return true;
  const resolved = isDyn(file) ? null : resolve(context, file);
  if (resolved != null && context.seen.has(resolved)) return true;
  let source = resolved == null ? UNKNOWN : context.pending.get(resolved);
  if (source == null && resolved != null) {
    if (mode === "path") {
      // A program that is not there, or not readable, runs nothing here.
      const head = readHead(resolved);
      if (head == null || !looksLikeShell(head)) return false;
    }
    source = readScript(context, file);
  }
  if (typeof source !== "string") return true;
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
  if (deletes) judgeDeletes(context, roots.length > 0 ? roots : ["."], text);
}

/**
 * PowerShell and cmd: other languages, read as words. Power, disk, elevation
 * (`runas`, `-Verb RunAs`) and deletes of a drive root, the home folder, a
 * folder holding it or a system folder are judged; nothing else is.
 */
function judgeWindowsShell(
  context: Context,
  tool: string,
  args: readonly string[],
  text: string
): void {
  const tokens = args
    .map(raw)
    .flatMap((arg) => arg.match(/"[^"]*"|'[^']*'|[^\s;|&(){}]+/g) ?? [])
    .map((token) => token.replace(/^(["'])([\s\S]*)\1$/, "$2"))
    .filter((token) => token.length > 0);
  const has = (re: RegExp): boolean => tokens.some((token) => re.test(token));
  for (const token of tokens) {
    const lower = token.toLowerCase().replace(/\.exe$/, "");
    if (POWER_CMDLETS.test(token) || POWER.has(lower))
      add(context, "power", "confirm", text);
    if (DISK_CMDLETS.test(token) || /^(?:diskpart|format)$/.test(lower))
      add(context, "disk", "confirm", text);
    if (/^(?:runas|gsudo)$/.test(lower) || /^-verb:runas$/i.test(token))
      add(context, "privileged", "confirm", text);
  }
  if (has(/^-verb$/i) && has(/^runas$/i))
    add(context, "privileged", "confirm", text);
  const home = windowsPath(context.options.home);
  tokens.forEach((token, at) => {
    if (!WINDOWS_DELETERS.test(token)) return;
    const target = tokens
      .slice(at + 1)
      .find((word) => !/^-\w+(?::.*)?$/.test(word) && !/^\/[a-z]$/i.test(word));
    if (target != null) judgeWindowsDelete(context, target, home, text);
  });
}

/** A path in one spelling: backslashes, lower case, no trailing `\` or `\*`. */
function windowsPath(value: string): string {
  let out = value.replace(/\//g, "\\").toLowerCase();
  while (/\\\*?$/.test(out) && out.length > 1 && !/^[a-z]:\\$/.test(out))
    out = out.replace(/\\\*?$/, "");
  return out;
}

function judgeWindowsDelete(
  context: Context,
  target: string,
  home: string,
  text: string
): void {
  if (
    /^(?:~|\$home|\$env:(?:userprofile|homedrive|systemdrive)|%(?:userprofile|homedrive|systemdrive)%)(?:[\\/]\*?)?$/i.test(
      target
    )
  ) {
    add(context, "deleteRoot", "never", text);
    return;
  }
  const where = windowsPath(target);
  if (
    /^(?:[a-z]:\\?|\\)$/.test(where) ||
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

  if (DELETERS.has(tool)) judgeDeletes(context, operands, text);
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
 * Stopping every process the user runs: `kill -1`, a negative pid, `kill 0`,
 * `killall5`, `pkill -u`, or a pattern that matches everything. Stopping one
 * process is not judged.
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
    return;
  }
  // A user's every process, or a pattern that matches every process.
  if (
    (tool === "pkill" || tool === "killall") &&
    (args.some((arg) => /^(?:-u|-U(?!SR)|--e?uid|--user)/.test(raw(arg))) ||
      operands.some(
        (operand) =>
          !isDyn(operand) && /^(?:\^?\.[*+]?\$?|\^|\.\*|)$/.test(operand)
      ))
  )
    add(context, "killAll", "confirm", text);
}

/** Each operand a delete names: never the disk or home, a yes for system folders. */
function judgeDeletes(
  context: Context,
  operands: readonly string[],
  text: string
): void {
  for (const operand of operands) {
    // A target nobody can read is not judged.
    const target = isDyn(operand) ? null : resolve(context, operand);
    if (target == null) continue;
    if (isRootOrHome(operand, target, context.options.home))
      add(context, "deleteRoot", "never", text);
    else if (isSystemPath(target, context.options))
      add(context, "systemDelete", "confirm", text);
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
        isFlagWith(arg, "f") ||
        isFlagWith(arg, "d") ||
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
// mq-sandbox test E
