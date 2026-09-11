/**
 * Every tool the agent registers, and what the gate decides about it.
 *
 * The gate keys on tool names, so a tool added without a thought for this file
 * is ungated by default — which is how `background` shipped able to run a shell
 * command in plan mode, a mode documented as "no file changes and no shell
 * commands". Nothing failed when that happened, because nothing was looking at
 * the whole roster at once.
 *
 * So this is the roster, as a table. A new tool has to be added here, and the
 * companion check in parity.e2e.test.ts fails if the agent offers one that is
 * not listed — which is what makes forgetting hard rather than silent.
 */
import { describe, expect, it } from "vitest";

import { gateToolCall, type GateOptions, type Gate } from "./permissions.js";
import { AgentMode, type ToolRequest } from "./protocol.js";

const WORKSPACE = "/tmp/workspace";

type Decision = Gate["kind"];

interface Case {
  /** The tool as the model calls it. */
  name: string;
  input: Record<string, unknown>;
  /** What the gate must decide, per mode. */
  normal: Decision;
  acceptEdits: Decision;
  plan: Decision;
  /** Why, when the answer is not obvious from the name. */
  because?: string;
}

const CASES: Case[] = [
  // Runs code or changes the disk: asks, and plan mode refuses.
  {
    name: "bash",
    input: { command: "echo hi" },
    normal: "ask",
    acceptEdits: "ask",
    plan: "refuse",
  },
  {
    name: "run_tests",
    input: {},
    normal: "ask",
    acceptEdits: "ask",
    plan: "refuse",
  },
  {
    name: "web_fetch",
    input: { url: "https://example.com" },
    normal: "ask",
    acceptEdits: "ask",
    plan: "refuse",
    because:
      "a URL is an outbound channel, so it carries the same class of consequence as a write",
  },

  // Edits inside the workspace: acceptEdits is what waves these through.
  {
    name: "write",
    input: { path: "a.ts", content: "x" },
    normal: "ask",
    acceptEdits: "allow",
    plan: "refuse",
  },
  {
    name: "edit",
    input: { path: "a.ts", oldText: "a", newText: "b" },
    normal: "ask",
    acceptEdits: "allow",
    plan: "refuse",
  },
  {
    name: "batch_edit",
    input: { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] },
    normal: "ask",
    acceptEdits: "allow",
    plan: "refuse",
  },
  {
    name: "ast_edit",
    input: { path: "a.ts", pattern: "x", rewrite: "y" },
    normal: "ask",
    acceptEdits: "allow",
    plan: "refuse",
  },

  // Hands the work to a sub-agent, which then runs unwatched. One answer covers
  // everything it goes on to do, so acceptEdits asks here as well.
  {
    name: "delegate_task",
    input: { task: "x" },
    normal: "ask",
    acceptEdits: "ask",
    plan: "refuse",
  },
  {
    name: "document",
    input: { brief: "a report", output_path: "out.pdf" },
    normal: "ask",
    acceptEdits: "ask",
    plan: "refuse",
  },
  {
    name: "ppt",
    input: { context: "a deck" },
    normal: "ask",
    acceptEdits: "ask",
    plan: "refuse",
  },
  {
    name: "design",
    input: { context: "a mockup" },
    normal: "ask",
    acceptEdits: "ask",
    plan: "refuse",
  },
  {
    name: "browser_task",
    input: { task: "open a page" },
    normal: "ask",
    acceptEdits: "ask",
    plan: "refuse",
  },

  // Not sub-agents, but the host writes a file at a path the model chose, which
  // is the same question a `write` asks.
  {
    name: "pdf",
    input: { output_path: "report.pdf" },
    normal: "ask",
    acceptEdits: "ask",
    plan: "refuse",
  },
  {
    name: "deck_export_pdf",
    input: { output_path: "deck.pdf" },
    normal: "ask",
    acceptEdits: "ask",
    plan: "refuse",
  },

  // Fetches a third-party SKILL.md and writes it where the agent reads its
  // instructions from. A write and an outbound fetch at once, and what lands is
  // text this agent will then follow — so acceptEdits, which is about edits to
  // the code in front of you, is not an answer to it.
  {
    name: "skill_add",
    input: { query: "pdf" },
    normal: "ask",
    acceptEdits: "ask",
    plan: "refuse",
  },

  // Puts a directory on an http port. Not a disk mutation, and the same
  // outbound-channel reasoning `web_fetch` already carries — more so, since the
  // directory is the model's choice and an absolute path is accepted.
  {
    name: "serve",
    input: { action: "start", directory: "site" },
    normal: "ask",
    acceptEdits: "ask",
    plan: "refuse",
  },

  // A clock. Nothing leaves and nothing changes.
  {
    name: "current_time",
    input: {},
    normal: "allow",
    acceptEdits: "allow",
    plan: "allow",
  },

  // Search is retrieval through a provider the user configured: the query is
  // the only thing that leaves, and unlike web_fetch the model does not pick
  // the host. Registered unconditionally (web/tools.ts), so it is always on
  // this roster's hook.
  {
    name: "web_search",
    input: { query: "example" },
    normal: "allow",
    acceptEdits: "allow",
    plan: "allow",
  },
  {
    name: "x_search",
    input: { query: "example" },
    normal: "allow",
    acceptEdits: "allow",
    plan: "allow",
    because:
      "same footing as web_search — a scoped search, not a model-chosen URL",
  },

  // Reads inside the workspace never prompt.
  {
    name: "read",
    input: { path: "a.ts" },
    normal: "allow",
    acceptEdits: "allow",
    plan: "allow",
  },
  {
    name: "batch_file_read",
    input: { paths: ["a.ts", "b.ts"] },
    normal: "allow",
    acceptEdits: "allow",
    plan: "allow",
  },
  {
    name: "grep",
    input: { pattern: "x" },
    normal: "allow",
    acceptEdits: "allow",
    plan: "allow",
  },
  {
    name: "find",
    input: { pattern: "*.ts" },
    normal: "allow",
    acceptEdits: "allow",
    plan: "allow",
  },
  {
    name: "ls",
    input: { path: "." },
    normal: "allow",
    acceptEdits: "allow",
    plan: "allow",
  },
  {
    name: "code_map",
    input: { path: "." },
    normal: "allow",
    acceptEdits: "allow",
    plan: "allow",
  },
  {
    name: "session_search",
    input: { query: "x" },
    normal: "allow",
    acceptEdits: "allow",
    plan: "allow",
  },
  {
    name: "todo",
    input: { action: "list" },
    normal: "allow",
    acceptEdits: "allow",
    plan: "allow",
  },

  // Report on, or stop, what this agent already started. None runs new code,
  // and refusing them in plan mode would stop it seeing its own state.
  {
    name: "read_output",
    input: { id: "bg-1" },
    normal: "allow",
    acceptEdits: "allow",
    plan: "allow",
  },
  {
    name: "serve",
    input: { action: "list" },
    normal: "allow",
    acceptEdits: "allow",
    plan: "allow",
  },
  {
    name: "present_deliverable",
    input: { paths: ["report.pdf"] },
    normal: "allow",
    acceptEdits: "allow",
    plan: "allow",
    because: "surfaces files that already exist; it writes nothing",
  },
  {
    name: "memory",
    input: { action: "add", text: "x" },
    normal: "allow",
    acceptEdits: "allow",
    plan: "allow",
    because: "the agent's own notebook, which cannot reach the user's files",
  },
  {
    name: "fetch_background_output",
    input: { id: "bg-1" },
    normal: "allow",
    acceptEdits: "allow",
    plan: "allow",
  },
  {
    name: "kill_process",
    input: { id: "bg-1" },
    normal: "allow",
    acceptEdits: "allow",
    plan: "allow",
  },
];

function options(mode: AgentMode): GateOptions {
  return {
    mode,
    cwd: WORKSPACE,
    allowedCommands: [],
    allowedTools: [],
    allowedReadPaths: [],
    allowedWritePaths: [],
    allowedOrigins: [],
  };
}

function call(name: string, input: Record<string, unknown>): ToolRequest {
  return {
    id: "tool-1",
    name,
    type: "tool",
    input,
    args: input,
  } as ToolRequest;
}

const label = (entry: Case): string =>
  `${entry.name}${entry.input.action != null ? ` (${String(entry.input.action)})` : ""}`;

describe("the gate, tool by tool", () => {
  it.each(CASES.map((entry) => [label(entry), entry] as const))(
    "%s",
    (_name, entry) => {
      expect(
        gateToolCall(call(entry.name, entry.input), options(AgentMode.Normal))
          .kind
      ).toBe(entry.normal);
      expect(
        gateToolCall(
          call(entry.name, entry.input),
          options(AgentMode.AcceptEdits)
        ).kind
      ).toBe(entry.acceptEdits);
      expect(
        gateToolCall(call(entry.name, entry.input), options(AgentMode.PlanMode))
          .kind
      ).toBe(entry.plan);
    }
  );

  it("lets everything through in yolo, which is what yolo means", () => {
    for (const entry of CASES) {
      expect(
        gateToolCall(call(entry.name, entry.input), options(AgentMode.Yolo))
          .kind
      ).toBe("allow");
    }
  });
});

describe("the same tools, reaching outside the workspace", () => {
  // The workspace is the boundary in both directions, and each of these takes
  // its path under a different argument name — so the gate has to understand
  // every spelling or the check silently passes.
  it.each([
    ["read", { path: "/etc/hosts" }],
    ["batch_file_read", { paths: ["/etc/hosts"] }],
    ["grep", { pattern: "x", path: "/etc" }],
    ["ls", { path: "/etc" }],
  ])("%s asks before reading there", (name, input) => {
    expect(
      gateToolCall(call(name, input), options(AgentMode.Normal)).kind
    ).toBe("ask");
  });

  it.each([
    ["write", { path: "/etc/hosts", content: "x" }],
    ["edit", { path: "/etc/hosts", oldText: "a", newText: "b" }],
    [
      "batch_edit",
      { path: "/etc/hosts", edits: [{ oldText: "a", newText: "b" }] },
    ],
  ])("%s asks before writing there, even in acceptEdits", (name, input) => {
    expect(
      gateToolCall(call(name, input), options(AgentMode.AcceptEdits)).kind
    ).toBe("ask");
  });
});
