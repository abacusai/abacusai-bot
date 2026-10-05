/**
 * R2-T23 (spec 02 §6.4): every `PermissionRequest` variant, from the
 * descriptor shapes the agent builds: title, the path field it reads, the
 * body (new content for edits, `content` for writes incl. overwrites,
 * notebook cells), and exactly the allowed decisions (the agent's
 * `allowedDecisions`, mirrored here). R2-T24 (§6.5): the questionnaire's
 * answers encode byte for byte like `chat-composer.tsx:1018-1037`.
 */
import type { PermissionRequest } from "@abacus-ai/agent";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadUntyped } from "#renderer/test-support/chat-relay";

import * as b from "../../fixtures/builders";
import { FakeRelay } from "../../fixtures/relay";
import { renderRelay } from "../../testing";
import {
  allowedActions,
  decisionKind,
  encodeAnswers,
  type QuestionItem,
} from "./decisions";
import { bashRule, present } from "./presenters";

let allowedFor: (type: PermissionRequest["type"]) => string[];
beforeAll(async () => {
  allowedFor = (
    await loadUntyped<{ allowedDecisions: typeof allowedFor }>(
      new URL(
        "../../../../../../../../packages/agent/src/agui/permissions.ts",
        import.meta.url
      ).pathname
    )
  ).allowedDecisions;
});

const tool = { id: "c1", name: "x", type: "x", input: {} };
const REQUESTS: Array<[PermissionRequest, RegExp | string, string[]]> = [
  [
    {
      type: "run_terminal",
      command: "git push",
      cwd: "/r",
      background: true,
      tool,
      displayName: "",
    } as PermissionRequest,
    "runCommand",
    ["accept", "rule", "background", "reject"],
  ],
  [
    {
      type: "run_terminal",
      command: "cat ~/.npmrc",
      cwd: "/r",
      background: false,
      credentialPaths: ["~/.npmrc"],
      tool,
      displayName: "",
    } as PermissionRequest,
    "credentials",
    ["accept", "reject"],
  ],
  [
    {
      type: "edit_file",
      filePath: "/r/src/a.ts",
      originalContent: "a",
      newContent: "b",
      tool,
      displayName: "",
    } as PermissionRequest,
    "editFile",
    ["accept", "allowAlways", "reject"],
  ],
  [
    {
      type: "write_file",
      filePath: "/r/new.ts",
      originalContent: "",
      content: "x",
      isNewFile: true,
      tool,
      displayName: "",
    } as PermissionRequest,
    "createFile",
    ["accept", "allowAlways", "reject"],
  ],
  [
    {
      type: "write_file",
      filePath: "/r/old.ts",
      originalContent: "a",
      content: "b",
      isNewFile: false,
      tool,
      displayName: "",
    } as PermissionRequest,
    "overwriteFile",
    ["accept", "allowAlways", "reject"],
  ],
  [
    {
      type: "notebook_edit",
      notebookPath: "/r/n.ipynb",
      editMode: "insert",
      cellType: "code",
      originalContent: "",
      newContent: "print(1)",
      tool,
      displayName: "",
    } as PermissionRequest,
    "notebook.insert",
    ["accept", "allowAlways", "reject"],
  ],
  [
    {
      type: "delete",
      filePath: "/r/x",
      tool,
      displayName: "",
    } as PermissionRequest,
    "deleteFile",
    ["accept", "reject"],
  ],
  [
    {
      type: "read_outside_directory",
      filePath: "../x",
      resolvedPath: "/x",
      deducedDirectory: "/",
      tool,
      displayName: "",
    } as PermissionRequest,
    "readOutside",
    ["accept", "allowAlways", "reject"],
  ],
  [
    {
      type: "write_outside_directory",
      filePath: "../x",
      resolvedPath: "/x",
      deducedDirectory: "/",
      isNewFile: true,
      tool,
      displayName: "",
    } as PermissionRequest,
    "writeOutside",
    ["accept", "allowAlways", "reject"],
  ],
  [
    {
      type: "edit_outside_directory",
      filePath: "../x",
      resolvedPath: "/x",
      deducedDirectory: "/",
      tool,
      displayName: "",
    } as PermissionRequest,
    "editOutside",
    ["accept", "allowAlways", "reject"],
  ],
  [
    {
      type: "notebook_edit_outside_directory",
      filePath: "../x",
      resolvedPath: "/x",
      deducedDirectory: "/",
      tool,
      displayName: "",
    } as PermissionRequest,
    "notebookOutside",
    ["accept", "allowAlways", "reject"],
  ],
  [
    {
      type: "network_host",
      host: "registry.npmjs.org",
      port: 443,
      tool,
      displayName: "",
    } as PermissionRequest,
    "networkHost",
    ["accept", "allowAlways", "reject"],
  ],
  [
    {
      type: "sandbox_denied",
      command: "npm i",
      denials: [{ kind: "write", path: "/x" }],
      tool,
      displayName: "",
    } as PermissionRequest,
    "sandboxDenied",
    ["accept", "allowAlways", "reject"],
  ],
  [
    {
      type: "fetch_url",
      url: "https://a.example/x?q=1",
      origin: "https://a.example",
      tool,
      displayName: "",
    } as PermissionRequest,
    "fetchUrl",
    ["accept", "allowAlways", "reject"],
  ],
  [
    {
      type: "browser_action",
      action: "click",
      description: "Click",
      tool,
      displayName: "",
    } as PermissionRequest,
    "browserAction",
    ["accept", "reject"],
  ],
  [
    {
      type: "generic",
      toolName: "gmail_send",
      inputSummary: "to x",
      tool,
      displayName: "",
    } as PermissionRequest,
    "generic",
    ["accept", "allowAlways", "reject"],
  ],
  [
    {
      type: "exit_plan_mode",
      planFilePath: "p.md",
      planContent: "1. a",
      tool,
      displayName: "",
    } as PermissionRequest,
    "exitPlan",
    ["accept", "allowAlways", "allowYolo", "reject"],
  ],
  [
    {
      type: "ask_user_question",
      questions: [],
      tool,
      displayName: "",
    } as PermissionRequest,
    "question",
    ["reject"],
  ],
];

describe("R2-T23 presenters", () => {
  it.each(REQUESTS)(
    "%#: title and exactly the allowed buttons",
    (request, title, ids) => {
      const model = present(request);
      expect(model.title).toBe(title);
      const descriptor = b.descriptor(request, {
        allowed: allowedFor(request.type),
      });
      const actions = allowedActions(descriptor, model.actions);
      expect(actions.map((a) => a.id)).toEqual(ids);
      for (const action of actions)
        expect(allowedFor(request.type)).toContain(
          decisionKind(action.decision)
        );
    }
  );

  it("bodies read the variant's own fields", () => {
    const edit = present(REQUESTS[2]![0]);
    expect(edit.body).toMatchObject({
      kind: "diff",
      additions: 1,
      deletions: 1,
    });
    expect(edit.titleValues).toEqual({ name: "a.ts" });
    expect(present(REQUESTS[3]![0]).body).toEqual({
      kind: "content",
      text: "x",
    });
    expect(present(REQUESTS[4]![0]).body).toMatchObject({ kind: "diff" });
    expect(present(REQUESTS[5]![0]).body).toMatchObject({
      kind: "diff",
      additions: 1,
      deletions: 0,
    });
    expect(present(REQUESTS[7]![0]).body).toEqual({ kind: "path", path: "/x" });
    expect(bashRule("x".repeat(130))).toBe(`Bash(${"x".repeat(120)}…)`);
  });

  it("a disallowed decision is never offered", () => {
    const descriptor = b.descriptor(REQUESTS[0]![0], {
      allowed: ["accept", "reject"],
    });
    expect(
      allowedActions(descriptor, present(REQUESTS[0]![0]).actions).map(
        (a) => a.id
      )
    ).toEqual(["accept", "reject"]);
  });
});

describe("R2-T24 questions", () => {
  const questions: QuestionItem[] = [
    {
      question: "Which?",
      header: "",
      multiSelect: false,
      options: [
        { label: "960", description: "" },
        { label: "768", description: "" },
      ],
    },
    {
      question: "Keep?",
      header: "",
      multiSelect: true,
      options: [
        { label: "A", description: "" },
        { label: "B", description: "" },
        { label: "C", description: "" },
      ],
    },
    {
      question: "Skip me",
      header: "",
      multiSelect: false,
      options: [{ label: "X", description: "" }],
    },
  ];

  it("encodes like the old composer", () => {
    const answers = encodeAnswers(
      questions,
      new Map([
        [0, new Set([1])],
        [1, new Set([2, 0])],
      ]),
      new Map([
        [1, "because"],
        [2, "ignored without a choice"],
      ])
    );
    expect(answers).toEqual({
      question_0: "768",
      question_1: "A, C — because",
    });
  });

  let current: Awaited<ReturnType<typeof renderRelay>> | null = null;
  afterEach(async () => {
    await current?.cleanup();
    current = null;
  });

  it("Skip all sends reject without answers", async () => {
    const request = {
      type: "ask_user_question",
      questions: [questions[0]],
      tool: { id: "c1", name: "ask_user_question", type: "x", input: {} },
      displayName: "",
    } as unknown as PermissionRequest;
    const d = b.descriptor(request, {
      id: "skip",
      allowed: ["question_answers", "reject"],
    });
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r1"),
      ...b.permissionEvents([d], d),
    ]);
    current = await renderRelay(relay, "session");
    fireEvent.click(await screen.findByRole("button", { name: "Skip all" }));
    await waitFor(() => expect(relay.stats.respond).toHaveLength(1));
    expect(relay.stats.respond[0]!.decision).toBe("reject");
  });

  it("letter shortcuts choose an answer and Mod+Enter submits", async () => {
    const request = {
      type: "ask_user_question",
      questions: [questions[0]],
      tool: { id: "c1", name: "ask_user_question", type: "x", input: {} },
      displayName: "",
    } as unknown as PermissionRequest;
    const d = b.descriptor(request, {
      id: "keys",
      allowed: ["question_answers", "reject"],
    });
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r1"),
      ...b.permissionEvents([d], d),
    ]);
    current = await renderRelay(relay, "session");
    const card = await screen.findByRole("group", {
      name: "The agent asks you a question",
    });
    const form = card.querySelector("form")!;
    fireEvent.keyDown(form, { key: "b" });
    fireEvent.keyDown(form, { key: "Enter", metaKey: true });
    await waitFor(() => expect(relay.stats.respond).toHaveLength(1));
    expect(relay.stats.respond[0]!.decision).toEqual({
      type: "question_answers",
      answers: { question_0: "768" },
    });
  });

  it("the rendered questionnaire sends question_answers; Skip all sends reject", async () => {
    const request = {
      type: "ask_user_question",
      questions: [questions[0]],
      tool: { id: "c1", name: "ask_user_question", type: "x", input: {} },
      displayName: "",
    } as unknown as PermissionRequest;
    const d = b.descriptor(request, {
      id: "q1",
      allowed: ["question_answers", "reject"],
    });
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r1"),
      ...b.permissionEvents([d], d),
    ]);
    current = await renderRelay(relay, "session");
    const card = await screen.findByRole("group", {
      name: "The agent asks you a question",
    });
    fireEvent.click(within(card).getByText("768"));
    fireEvent.click(within(card).getByRole("button", { name: /Submit/ }));
    await waitFor(() => expect(relay.stats.respond).toHaveLength(1));
    expect(relay.stats.respond[0]!.decision).toEqual({
      type: "question_answers",
      answers: { question_0: "768" },
    });
  });
});
