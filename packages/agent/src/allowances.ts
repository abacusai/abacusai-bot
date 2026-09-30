/**
 * What the user has allowed for the rest of this process, and how a fresh
 * "Always allow" widens it: to the command's first word for a shell call
 * (`npm test` must not approve `npm publish`), the origin for a fetch, the
 * directory the card named for a file outside the workspace, and the tool as
 * a whole only for the rest. One rule for both loops: the bot loop once kept
 * only tools and commands, so allowing one `read ~/Documents/x` allowed every
 * read, grep, write and edit anywhere on disk for good, while a fetch's
 * origin was never kept and asked again every time.
 */
import type { GateOptions } from "./permissions.js";
import { shellSegments } from "./permissions.js";
import type { PermissionRequest, ToolRequest } from "./protocol.js";

const addUnique = (store: string[], value: string): void => {
  if (value.length > 0 && !store.includes(value)) store.push(value);
};

export class Allowances {
  /** Commands (by first word) the user chose to always allow. */
  readonly commands: string[] = [];
  /** Non-shell tools allowed as a whole. */
  readonly tools = new Set<string>();
  /** Origins web_fetch may reach without asking. */
  readonly origins: string[] = [];
  /** Directories outside the workspace allowed for reads. */
  readonly readPaths: string[];
  /** Directories outside the workspace allowed for writes. */
  readonly writePaths: string[];

  constructor(seed: { readPaths?: string[]; writePaths?: string[] } = {}) {
    this.readPaths = [...(seed.readPaths ?? [])];
    this.writePaths = [...(seed.writePaths ?? [])];
  }

  /** "Always allow" on a card: widen by exactly what the card asked about. */
  remember(tool: ToolRequest, request: PermissionRequest): void {
    // Scoped to the directory the card named; the tool-level fallback below
    // would grant `write` everywhere.
    switch (request.type) {
      case "read_outside_directory":
        addUnique(this.readPaths, request.deducedDirectory);
        return;
      case "write_outside_directory":
      case "edit_outside_directory":
      case "notebook_edit_outside_directory":
        addUnique(this.writePaths, request.deducedDirectory);
        return;
      default:
        break;
    }

    if (tool.name === "web_fetch") {
      try {
        addUnique(this.origins, new URL(String(tool.input.url ?? "")).origin);
      } catch {
        // Unparseable never reached the network; nothing to remember.
      }
      return;
    }

    if (tool.name !== "bash") {
      this.tools.add(tool.name);
      return;
    }

    this.allowCommand(String(tool.input.command ?? ""));
  }

  /** Every segment of `cd repo && git pull`, or the `git` half asks again. */
  allowCommand(command: string): void {
    for (const segment of shellSegments(command)) {
      // Skip leading VAR=val tokens so `FOO=1 npm test` remembers `npm`.
      const head = segment
        .split(/\s+/)
        .find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));

      if (head != null) addUnique(this.commands, head);
    }
  }

  /** Rules the user wrote on the card, verbatim. */
  allowCommandRules(rules: readonly string[]): void {
    for (const rule of rules) addUnique(this.commands, rule);
  }

  /**
   * The gate's view of what is allowed, on top of what the host configured
   * (`base`: config-level commands and read paths, tools a loop always has).
   */
  gateOptions(
    base: {
      commands?: readonly string[];
      tools?: readonly string[];
      readPaths?: readonly string[];
    } = {}
  ): Pick<
    GateOptions,
    | "allowedCommands"
    | "allowedTools"
    | "allowedReadPaths"
    | "allowedWritePaths"
    | "allowedOrigins"
  > {
    return {
      allowedCommands: [...(base.commands ?? []), ...this.commands],
      allowedTools: [...(base.tools ?? []), ...this.tools],
      allowedReadPaths: [...(base.readPaths ?? []), ...this.readPaths],
      allowedWritePaths: [...this.writePaths],
      allowedOrigins: [...this.origins],
    };
  }
}
