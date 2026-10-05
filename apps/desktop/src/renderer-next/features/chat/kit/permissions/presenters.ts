/**
 * One presenter per `PermissionRequest` variant (spec 02 §6.4), pure and
 * exhaustive: a new variant is a type error. A presenter says what the card
 * shows and which buttons it offers; `decisions.ts` drops any button whose
 * decision the descriptor does not allow.
 */
import type { PermissionDecision, PermissionRequest } from "@abacus-ai/agent";

import { diffLines, parseUnified, type DiffLine } from "../tools/normalize";

type ActionVariant = "primary" | "secondary" | "deny" | "warning";

export interface CardAction {
  id: string;
  /** i18n key under `chat.permission.action`. */
  label: string;
  values?: Record<string, string>;
  decision: PermissionDecision;
  variant: ActionVariant;
}

export type CardBody =
  | { kind: "command"; command: string; cwd?: string }
  | { kind: "diff"; lines: DiffLine[]; additions: number; deletions: number }
  | { kind: "content"; text: string }
  | { kind: "text"; text: string }
  | { kind: "path"; path: string }
  | { kind: "plan"; markdown: string }
  | {
      kind: "denials";
      command: string;
      denials: Array<{ verb: "read" | "write" | "reach"; target: string }>;
      note?: string;
    }
  | { kind: "question" }
  | { kind: "none" };

export interface CardModel {
  /** i18n key under `chat.permission.title` and its values. */
  title: string;
  titleValues?: Record<string, string>;
  /** Right-hand label (mode, `+a -d`). */
  aside?:
    | { kind: "mode" }
    | { kind: "changes"; additions: number; deletions: number };
  /** An orange dot before the title. */
  warning?: boolean;
  description?: string;
  body: CardBody;
  paths?: string[];
  actions: CardAction[];
  /** Plan cards stack full-width buttons. */
  stacked?: boolean;
  /** "…" = Add a note: accept/reject become `*_with_message` with text. */
  note: boolean;
  /** Browser actions render only after 150 ms pending (§6.4). */
  delayed?: boolean;
  /** Short chip label for the tray (§6.2). */
  chip: string;
  chipValues?: Record<string, string>;
}

const basename = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** Today's "Always allow" rule for a command (F20). */
export const bashRule = (command: string): string =>
  `Bash(${command.slice(0, 120)}${command.length > 120 ? "…" : ""})`;

const split = (text: string): string[] => (text === "" ? [] : text.split("\n"));

const diffOf = (original: string, next: string, unified?: string): CardBody => {
  const lines =
    unified != null && unified !== ""
      ? parseUnified(unified)
      : diffLines(split(original), split(next));
  return {
    kind: "diff",
    lines,
    additions: lines.filter((line) => line.kind === "add").length,
    deletions: lines.filter((line) => line.kind === "del").length,
  };
};

const allowOnce = (): CardAction => ({
  id: "accept",
  label: "allowOnce",
  decision: "accept",
  variant: "primary",
});
const deny = (): CardAction => ({
  id: "reject",
  label: "deny",
  decision: "reject",
  variant: "deny",
});

const fileActions = (): CardAction[] => [
  allowOnce(),
  {
    id: "allowAlways",
    label: "alwaysAcceptEdits",
    decision: "allowAlways",
    variant: "secondary",
  },
  deny(),
];

const outsideVerb: Record<string, string> = {
  read_outside_directory: "readOutside",
  write_outside_directory: "writeOutside",
  edit_outside_directory: "editOutside",
  notebook_edit_outside_directory: "notebookOutside",
};

export const present = (request: PermissionRequest): CardModel => {
  switch (request.type) {
    case "run_terminal": {
      if (request.credentialPaths != null && request.credentialPaths.length > 0)
        return {
          title: "credentials",
          warning: true,
          body: { kind: "command", command: request.command, cwd: request.cwd },
          paths: request.credentialPaths,
          actions: [
            {
              id: "accept",
              label: "allowOnce",
              decision: "accept",
              variant: "secondary",
            },
            {
              id: "reject",
              label: "deny",
              decision: "reject",
              variant: "primary",
            },
          ],
          note: true,
          chip: "runCommand",
        };
      const rule = bashRule(request.command);
      return {
        title: "runCommand",
        aside: { kind: "mode" },
        body: { kind: "command", command: request.command, cwd: request.cwd },
        actions: [
          allowOnce(),
          {
            id: "rule",
            label: "alwaysAllowRule",
            values: { rule },
            decision: { type: "allow_always_with_rules", rules: [rule] },
            variant: "secondary",
          },
          ...(request.background
            ? [
                {
                  id: "background",
                  label: "runInBackground",
                  decision: "background",
                  variant: "secondary",
                } as CardAction,
              ]
            : []),
          deny(),
        ],
        note: true,
        chip: "runCommand",
      };
    }
    case "edit_file": {
      const body = diffOf(
        request.originalContent,
        request.newContent,
        request.diffContent
      );
      const changes =
        body.kind === "diff"
          ? { additions: body.additions, deletions: body.deletions }
          : { additions: 0, deletions: 0 };
      return {
        title: "editFile",
        titleValues: { name: basename(request.filePath) },
        aside: { kind: "changes", ...changes },
        body,
        actions: fileActions(),
        note: true,
        chip: "editFile",
        chipValues: { name: basename(request.filePath) },
      };
    }
    case "write_file": {
      const name = basename(request.filePath);
      if (request.isNewFile)
        return {
          title: "createFile",
          titleValues: { name },
          body: {
            kind: "content",
            text: split(request.content).slice(0, 12).join("\n"),
          },
          actions: fileActions(),
          note: true,
          chip: "createFile",
          chipValues: { name },
        };
      const body = diffOf(request.originalContent, request.content);
      return {
        title: "overwriteFile",
        titleValues: { name },
        ...(body.kind === "diff"
          ? {
              aside: {
                kind: "changes" as const,
                additions: body.additions,
                deletions: body.deletions,
              },
            }
          : {}),
        body,
        actions: fileActions(),
        note: true,
        chip: "editFile",
        chipValues: { name },
      };
    }
    case "notebook_edit": {
      const name = basename(request.notebookPath);
      const body =
        request.editMode === "insert"
          ? diffOf("", request.newContent)
          : request.editMode === "delete"
            ? diffOf(request.originalContent, "")
            : diffOf(request.originalContent, request.newContent);
      return {
        title: `notebook.${request.editMode}`,
        titleValues: { name, cell: request.cellType ?? "cell" },
        body,
        actions: fileActions(),
        note: true,
        chip: "editFile",
        chipValues: { name },
      };
    }
    case "delete":
      return {
        title: "deleteFile",
        titleValues: { name: basename(request.filePath) },
        body: { kind: "path", path: request.filePath },
        actions: [allowOnce(), deny()],
        note: true,
        chip: "deleteFile",
        chipValues: { name: basename(request.filePath) },
      };
    case "read_outside_directory":
    case "write_outside_directory":
    case "edit_outside_directory":
    case "notebook_edit_outside_directory":
      return {
        title: outsideVerb[request.type]!,
        body: { kind: "path", path: request.resolvedPath },
        actions: [
          allowOnce(),
          {
            id: "allowAlways",
            label: "alwaysAllowFolder",
            values: { folder: request.deducedDirectory },
            decision: "allowAlways",
            variant: "secondary",
          },
          deny(),
        ],
        note: true,
        chip: "outside",
      };
    case "network_host":
      return {
        title: "networkHost",
        titleValues: { host: request.host },
        description: "networkHostDescription",
        body: { kind: "none" },
        actions: [
          allowOnce(),
          {
            id: "allowAlways",
            label: "alwaysAllowHost",
            decision: "allowAlways",
            variant: "secondary",
          },
          deny(),
        ],
        note: true,
        chip: "connect",
        chipValues: { host: request.host },
      };
    case "sandbox_denied":
      return {
        title: "sandboxDenied",
        warning: true,
        description: "sandboxDeniedDescription",
        body: {
          kind: "denials",
          command: request.command,
          denials: request.denials.map((denial) =>
            denial.kind === "host"
              ? {
                  verb: "reach" as const,
                  target: `${denial.host}:${denial.port}`,
                }
              : { verb: denial.kind, target: denial.path }
          ),
          ...(request.note != null ? { note: request.note } : {}),
        },
        actions: [
          allowOnce(),
          {
            id: "allowAlways",
            label: "alwaysAllowThese",
            decision: "allowAlways",
            variant: "secondary",
          },
          deny(),
        ],
        note: true,
        chip: "runCommand",
      };
    case "fetch_url":
      return {
        title: "fetchUrl",
        titleValues: { origin: request.origin },
        body: { kind: "command", command: request.url },
        actions: [
          allowOnce(),
          {
            id: "allowAlways",
            label: "alwaysAllowSite",
            decision: "allowAlways",
            variant: "secondary",
          },
          deny(),
        ],
        note: true,
        chip: "connect",
        chipValues: { host: request.origin },
      };
    case "browser_action":
      return {
        title: "browserAction",
        titleValues: { description: request.description },
        body:
          request.url != null
            ? { kind: "command", command: request.url }
            : { kind: "none" },
        actions: [allowOnce(), deny()],
        note: false,
        delayed: true,
        chip: "browser",
      };
    case "generic":
      return {
        title: "generic",
        titleValues: { tool: request.toolName },
        body: { kind: "text", text: request.inputSummary },
        actions: [
          allowOnce(),
          {
            id: "allowAlways",
            label: "alwaysAllow",
            decision: "allowAlways",
            variant: "secondary",
          },
          deny(),
        ],
        note: true,
        chip: "generic",
        chipValues: { tool: request.toolName },
      };
    case "exit_plan_mode":
      return {
        title: "exitPlan",
        body: { kind: "plan", markdown: request.planContent },
        stacked: true,
        actions: [
          {
            id: "accept",
            label: "planApproveEach",
            decision: "accept",
            variant: "primary",
          },
          {
            id: "allowAlways",
            label: "planAcceptAll",
            decision: "allowAlways",
            variant: "secondary",
          },
          {
            id: "allowYolo",
            label: "planFullAccess",
            decision: "allowYolo",
            variant: "warning",
          },
          {
            id: "reject",
            label: "planKeepPlanning",
            decision: "reject",
            variant: "deny",
          },
        ],
        note: true,
        chip: "plan",
      };
    case "ask_user_question":
      return {
        title: "question",
        body: { kind: "question" },
        actions: [
          {
            id: "reject",
            label: "skipAll",
            decision: "reject",
            variant: "deny",
          },
        ],
        note: false,
        chip: "question",
      };
  }
};
