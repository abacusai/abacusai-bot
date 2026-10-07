/**
 * The real AguiHost (HostCore, admission, emitter, run controller, sink) over
 * a scripted session, for §7.5 behaviour the fake provider cannot produce:
 *
 * - two permissions pending at once, answered in reverse order, and one of
 *   them expiring while the other stays answerable. pi 0.85 prepares sibling
 *   tool calls one after another (agent-loop.js executeToolCallsParallel
 *   awaits each prepareToolCall, gate included, before any runs), so two gate
 *   cards never coexist; concurrent cards come from sandbox asks of commands
 *   already running, which need an OS sandbox;
 * - a permission raised in bot housekeeping after the user's run settled;
 * - browser auto-allow answering with the legacy command;
 * - sandbox/network attach to a sub-agent's running command, and a browser
 *   child's web-N text, through main's relay into a fresh processor.
 */
import { StreamProcessor } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import type { PermissionDecision, PermissionRequest } from "../protocol.js";
import { violations } from "./__tests__/invariants.js";
import { Relay } from "./__tests__/relay.js";
import {
  scripted,
  toolRequest,
  type Answer,
  type Scripted,
} from "./__tests__/scripted-session.js";
import { isRunScoped } from "./event.js";
import { newestUserMessage } from "./host.js";
import { allowedDecisions } from "./permissions.js";
import type { AguiEvent, PermissionDescriptor, RunInput } from "./wire.js";

const run = (runId: string, text: string) => ({
  type: "run",
  input: {
    threadId: "t-1",
    runId,
    messages: [{ id: `u-${runId}`, role: "user", content: text }],
    tools: [],
    context: [],
    state: {},
  },
});

const sandboxDenied = (
  permissionId: string,
  command: string
): PermissionRequest => ({
  type: "sandbox_denied",
  tool: toolRequest(permissionId, "sandbox", { command }),
  displayName: "Allow what the sandbox refused",
  command,
  denials: [{ kind: "write", path: `/outside/${permissionId}` }],
});

const pending = (s: Scripted): PermissionDescriptor[] =>
  s.custom<{ items: PermissionDescriptor[] }>("permission.pending").at(-1)
    ?.items ?? [];

const lineage = (s: Scripted, permissionId: string) => {
  const item = pending(s).find((entry) => entry.id === permissionId);

  if (item == null) throw new Error(`${permissionId} is not pending`);

  return item.metadata.abacus.lineage;
};

const resultFor = (s: Scripted, toolCallId: string) =>
  s
    .events()
    .find(
      (event) =>
        event.type === "TOOL_CALL_RESULT" &&
        (event as { toolCallId: string }).toolCallId === toolCallId
    );

/** Two sandboxed commands running at once, each asking about a denial. */
const twoAsks =
  (expireFirst = false) =>
  async (api: Parameters<Parameters<typeof scripted>[0]>[0]) => {
    const bash = (id: string, command: string) =>
      api.agent({
        type: "tool_execution_start",
        tool: toolRequest(id, "bash", { command }),
      });
    const complete = (id: string, command: string, answer: Answer) =>
      api.agent({
        type: "tool_execution_complete",
        tool: toolRequest(id, "bash", { command }),
        result: {
          id,
          content: `${command}: ${typeof answer === "string" ? answer : answer.type}`,
          rejected: answer !== "accept",
        },
      });

    bash("call-1", "touch /outside/one");
    bash("call-2", "touch /outside/two");
    const first = api.ask(
      "perm-1",
      sandboxDenied("perm-1", "touch /outside/one")
    );
    const second = api.ask(
      "perm-2",
      sandboxDenied("perm-2", "touch /outside/two")
    );

    if (expireFirst) {
      await api.gate("expire");
      api.expire("perm-1");
    }
    await Promise.all([
      first.then((answer) => complete("call-1", "touch /outside/one", answer)),
      second.then((answer) => complete("call-2", "touch /outside/two", answer)),
    ]);
    api.agent({ type: "text_delta", content: "Both handled." });
  };

describe("two permissions pending at once", () => {
  it("answers the second first: its waiter alone is released and its result arrives while the first still waits", async () => {
    const s = await scripted(twoAsks());

    s.send(run("r", "touch both"));
    await s.waitFor(() => pending(s).length === 2, "both cards up");

    // Each card attaches to its own running command.
    expect(
      pending(s).map((item) => [
        item.id,
        item.toolCallId,
        item.metadata.abacus.attachedBy,
      ])
    ).toEqual([
      ["perm-1", "call-1", "command-match"],
      ["perm-2", "call-2", "command-match"],
    ]);

    s.send({
      type: "permission.respond",
      lineage: lineage(s, "perm-2"),
      decision: "accept",
    });
    await s.waitFor(() => resultFor(s, "call-2") != null, "second result");

    expect(s.session.answers).toEqual([
      { permissionId: "perm-2", decision: "accept" },
    ]);
    expect(pending(s).map((item) => item.id)).toEqual(["perm-1"]);
    expect(resultFor(s, "call-1")).toBeUndefined();
    expect(s.host.runs.isOpen()).toBe(true);

    s.send({
      type: "permission.respond",
      lineage: lineage(s, "perm-1"),
      decision: "reject",
    });
    await s.waitFor(
      (events) => events.some((event) => event.type === "RUN_FINISHED"),
      "run finished"
    );
    expect(s.session.answers.map((answer) => answer.permissionId)).toEqual([
      "perm-2",
      "perm-1",
    ]);
    expect(
      s.custom<{ permissionId: string; source: string }>("permission.resolved")
    ).toEqual([
      { permissionId: "perm-2", decisionKind: "accept", source: "respond" },
      { permissionId: "perm-1", decisionKind: "reject", source: "respond" },
    ]);
    expect(violations(s.events())).toEqual([]);
    await s.close();
  });

  it("writes the same compat bytes as the legacy permission_response in the same order", async () => {
    const answered = async (legacy: boolean): Promise<string> => {
      const s = await scripted(twoAsks());

      s.send({ type: "send", message: "touch both" });
      await s.waitFor(() => pending(s).length === 2, "both cards up");
      for (const [permissionId, decision] of [
        ["perm-2", "accept"],
        ["perm-1", "reject"],
      ] as const) {
        s.send(
          legacy
            ? { type: "permission_response", permissionId, decision }
            : {
                type: "permission.respond",
                lineage: lineage(s, permissionId),
                decision,
              }
        );
        await s.waitFor(
          () => !pending(s).some((item) => item.id === permissionId),
          `${permissionId} answered`
        );
      }
      await s.close();

      return s.compat();
    };

    expect(await answered(false)).toBe(await answered(true));
  });

  it("expires one while the other stays answerable, and that answer applies", async () => {
    const s = await scripted(twoAsks(true));

    s.send(run("r", "touch both"));
    await s.waitFor(() => pending(s).length === 2, "both cards up");
    s.session.open("expire");
    await s.waitFor(
      () => s.custom("permission.cleared").length === 1,
      "first expired"
    );

    expect(s.custom("permission.cleared")).toEqual([
      { permissionId: "perm-1", reason: "expired" },
    ]);
    expect(pending(s).map((item) => item.id)).toEqual(["perm-2"]);

    s.send({
      type: "permission.respond",
      lineage: lineage(s, "perm-2"),
      decision: "accept",
    });
    await s.waitFor(
      (events) => events.some((event) => event.type === "RUN_FINISHED"),
      "run finished"
    );
    expect(s.session.answers).toEqual([
      { permissionId: "perm-2", decision: "accept" },
    ]);
    expect(violations(s.events())).toEqual([]);
    await s.close();
  });
});

describe("a housekeeping permission (finding r2-13)", () => {
  const housekeeping = async (
    api: Parameters<Parameters<typeof scripted>[0]>[0]
  ) => {
    api.agent({ type: "text_delta", content: "Hi.", messageId: "msg-1" });
    // The user's reply is over; the bot's hidden turn follows.
    api.settled();
    api.internal({
      type: "hidden_turn",
      phase: "start",
      customType: "abacusai-bot:memory-flush",
    });
    const answer = await api.ask("perm-1", {
      type: "write_file",
      tool: toolRequest("call-h", "write", { path: "MEMORY.md" }),
      displayName: "Update memory",
      filePath: "MEMORY.md",
      originalContent: "",
      content: "- met the user\n",
      isNewFile: true,
    });

    api.agent({
      type: "text_delta",
      content: `hidden ${typeof answer === "string" ? answer : answer.type}`,
    });
    api.internal({
      type: "hidden_turn",
      phase: "end",
      customType: "abacusai-bot:memory-flush",
    });
  };

  it("carries its turn but no run, hydrates into a fresh window, and its answer releases the waiter", async () => {
    const s = await scripted(housekeeping);
    const relay = new Relay();

    s.send(run("r", "hello bot"));
    await s.waitFor(() => pending(s).length === 1, "housekeeping card");
    for (const event of s.events()) relay.ingest(event);

    const names = s
      .events()
      .map((event) => (event.type === "CUSTOM" ? event.name : event.type));

    // The user's run ended before housekeeping asked.
    expect(names.indexOf("RUN_FINISHED")).toBeLessThan(
      names.indexOf("permission.requested")
    );
    const [descriptor] = pending(s) as [PermissionDescriptor];

    expect(descriptor.metadata.abacus.lineage.turnSeq).toBeGreaterThan(0);
    expect(descriptor.metadata.abacus.lineage.runId).toBeUndefined();

    // A fresh window gets it from main's store and answers with its lineage.
    const restored = relay.hydrate().descriptors;

    expect(restored.map((item) => item.id)).toEqual(["perm-1"]);
    s.send({
      type: "permission.respond",
      lineage: restored[0]!.metadata.abacus.lineage,
      decision: "accept",
    });
    await s.waitFor(() => pending(s).length === 0, "answered");
    expect(s.session.answers).toEqual([
      { permissionId: "perm-1", decision: "accept" },
    ]);
    await s.close();

    // Nothing from inside the hidden turn reached AG-UI but permissions and
    // the session-scoped queue the answer updates; after it, only status.
    const after = s
      .events()
      .slice(
        s.events().findIndex((event) => event.type === "RUN_FINISHED") + 1
      );

    expect(after.filter((event) => isRunScoped(event))).toEqual([]);
    expect(
      after
        .map((event) => (event.type === "CUSTOM" ? event.name : event.type))
        .filter(
          (name) => !name.startsWith("permission.") && name !== "queue.updated"
        )
    ).toEqual(["agent.status", "agent.status"]);
    expect(
      s
        .events()
        .some(
          (event) =>
            event.type === "TEXT_MESSAGE_CONTENT" &&
            (event as { delta: string }).delta.startsWith("hidden")
        )
    ).toBe(false);
  });

  it("clears on expiry like any other card", async () => {
    const s = await scripted(async (api) => {
      api.settled();
      api.internal({ type: "hidden_turn", phase: "start", customType: "x" });
      const answer = api.ask("perm-1", {
        type: "generic",
        tool: toolRequest("call-h", "memory", {}),
        displayName: "Memory",
        toolName: "memory",
        inputSummary: "",
      });

      await api.gate("expire");
      api.expire("perm-1");
      await answer;
      api.internal({ type: "hidden_turn", phase: "end", customType: "x" });
    });

    s.send(run("r", "hi"));
    await s.waitFor(() => pending(s).length === 1, "card");
    s.session.open("expire");
    await s.waitFor(
      () => s.custom("permission.cleared").length === 1,
      "expired"
    );
    expect(pending(s)).toEqual([]);
    expect(s.custom("permission.cleared")).toEqual([
      { permissionId: "perm-1", reason: "expired" },
    ]);
    await s.close();
  });
});

describe("browser auto-allow (§3.5.6)", () => {
  it("shows requested then resolved{legacy_response} when main answers with the legacy command", async () => {
    const s = await scripted(async (api) => {
      const tool = toolRequest("call-b", "browser_navigate", {
        url: "https://example.com",
      });

      api.agent({ type: "tool_execution_start", tool });
      const answer = await api.ask("perm-1", {
        type: "browser_action",
        tool,
        displayName: "Open a page",
        action: "navigate",
        url: "https://example.com",
        description: "Open example.com",
      });

      api.agent({
        type: "tool_execution_complete",
        tool,
        result: {
          id: "call-b",
          content: "opened",
          rejected: answer !== "accept",
        },
      });
    });

    s.send(run("r", "open it"));
    await s.waitFor(() => pending(s).length === 1, "card");
    // What AgentCommunicationService writes on seeing permission_needed.
    s.send({
      type: "permission_response",
      permissionId: "perm-1",
      decision: "accept",
    });
    await s.waitFor(
      (events) => events.some((event) => event.type === "RUN_FINISHED"),
      "done"
    );

    const names = s
      .events()
      .map((event) => (event.type === "CUSTOM" ? event.name : event.type));

    expect(names.indexOf("permission.requested")).toBeLessThan(
      names.indexOf("permission.resolved")
    );
    expect(s.custom("permission.resolved")).toEqual([
      {
        permissionId: "perm-1",
        decisionKind: "accept",
        source: "legacy_response",
      },
    ]);
    expect(resultFor(s, "call-b")).toMatchObject({
      content: expect.stringContaining('"rejected":false'),
    });
    await s.close();
  });
});

describe("through main's relay (synthetic: needs an OS sandbox or a browser for real)", () => {
  it("attaches a network ask to a sub-agent's sole running command, and restores the card and the child's web-N text into a fresh window", async () => {
    const s = await scripted(async (api) => {
      const child = { subagentRunId: "browser-1" };

      api.agent(
        {
          type: "subtask_start",
          id: "browser-1",
          kind: "browser",
          description: "look it up",
        },
        { parentToolCallId: "call-p" }
      );
      api.agent(
        {
          type: "tool_execution_start",
          tool: toolRequest("browser-call-1", "bash", {
            command: "curl example.com",
          }),
        },
        child
      );
      api.agent(
        { type: "text_delta", content: "Looking", messageId: "web-1" },
        child
      );
      await api.gate("reload");
      const answer = await api.ask("perm-1", {
        type: "network_host",
        tool: toolRequest("perm-1", "network", {
          host: "example.com",
          port: 443,
        }),
        displayName: "Reach a host",
        host: "example.com",
        port: 443,
      });

      api.agent(
        {
          type: "tool_execution_complete",
          tool: toolRequest("browser-call-1", "bash", {
            command: "curl example.com",
          }),
          result: {
            id: "browser-1-call",
            content: "fetched",
            rejected: answer !== "accept",
          },
        },
        child
      );
      api.agent(
        { type: "text_delta", content: "Found it", messageId: "web-2" },
        child
      );
      api.agent(
        { type: "subtask_end", id: "browser-1", status: "completed" },
        child
      );
    });
    const relay = new Relay();
    let fed = 0;
    const feed = () => {
      for (const event of s.events().slice(fed)) relay.ingest(event);
      fed = s.events().length;
    };

    s.send(run("r", "find it"));
    await s.waitFor(
      (events) =>
        events.some(
          (event) =>
            event.type === "TEXT_MESSAGE_CONTENT" &&
            (event as { subagentRunId?: string }).subagentRunId === "browser-1"
        ),
      "child text"
    );
    s.session.open("reload");
    await s.waitFor(() => pending(s).length === 1, "card");
    feed();

    const [descriptor] = pending(s) as [PermissionDescriptor];

    expect(descriptor).toMatchObject({
      toolCallId: "browser-1:browser-call-1",
      subagentRunId: "browser-1",
      metadata: { abacus: { attachedBy: "sole-running" } },
    });

    // A window opened now: hydrate + joinRun, then the live tail.
    const checkpoint = relay.hydrate();

    expect(checkpoint.descriptors.map((item) => item.id)).toEqual(["perm-1"]);
    const fresh = new StreamProcessor();
    const joined: AguiEvent[] = [];
    const replay = (async () => {
      for await (const event of relay.joinRun(checkpoint.activeRun!.runId)) {
        joined.push(event);
        fresh.processChunk(event as never);
      }
    })();

    s.send({
      type: "permission.respond",
      lineage: checkpoint.descriptors[0]!.metadata.abacus.lineage,
      decision: "accept",
    });
    await s.waitFor(
      (events) => events.some((event) => event.type === "RUN_FINISHED"),
      "done"
    );
    feed();
    await replay;

    // The restored window ends with exactly what a live window has.
    const live = new StreamProcessor();

    for (const event of s.events()) live.processChunk(event as never);
    const card = (messages: ReturnType<StreamProcessor["getMessages"]>) =>
      messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "subagent") as {
        subagent: {
          status: string;
          messages: Array<{ id: string; parts: Array<{ type: string }> }>;
        };
      };

    expect(card(fresh.getMessages()).subagent.status).toBe("finished");
    expect(
      card(fresh.getMessages()).subagent.messages.map((m) => m.id)
    ).toEqual(card(live.getMessages()).subagent.messages.map((m) => m.id));
    expect(card(live.getMessages()).subagent.messages.map((m) => m.id)).toEqual(
      expect.arrayContaining(["browser-1:web-1", "browser-1:web-2"])
    );
    expect(violations(s.events())).toEqual([]);
    await s.close();
  });
});

describe("the run's user text (Claude r1 #11)", () => {
  const input = (messages: unknown[]): RunInput =>
    ({
      threadId: "t",
      runId: "r",
      messages,
      tools: [],
      context: [],
      state: {},
    }) as unknown as RunInput;

  it("reads AG-UI, ModelMessage and UIMessage shapes alike", () => {
    expect(
      newestUserMessage(input([{ id: "a", role: "user", content: "plain" }]))
    ).toEqual({ id: "a", text: "plain" });
    expect(
      newestUserMessage(
        input([
          {
            id: "b",
            role: "user",
            content: [
              { type: "text", text: "ag" },
              { type: "text", text: "ui" },
            ],
          },
        ])
      )
    ).toEqual({ id: "b", text: "agui" });
    expect(
      newestUserMessage(
        input([
          {
            id: "c",
            role: "user",
            content: [{ type: "text", content: "model" }],
          },
        ])
      )
    ).toEqual({ id: "c", text: "model" });
    expect(
      newestUserMessage(
        input([
          {
            id: "old",
            role: "user",
            parts: [{ type: "text", content: "older" }],
          },
          {
            id: "x",
            role: "assistant",
            parts: [{ type: "text", content: "reply" }],
          },
          {
            id: "d",
            role: "user",
            parts: [
              { type: "text", content: "ui" },
              { type: "image", source: {} },
              { type: "text", content: "message" },
            ],
          },
        ])
      )
    ).toEqual({ id: "d", text: "uimessage" });
  });

  it("finds no text in an image-only message, which is rejected as empty", () => {
    expect(
      newestUserMessage(
        input([
          { id: "e", role: "user", parts: [{ type: "image", source: {} }] },
        ])
      )
    ).toEqual({ id: "e", text: "" });
  });
});

describe("the decision envelope (§3.5.2, §7.5)", () => {
  const sample: Record<string, PermissionDecision> = {
    accept: "accept",
    reject: "reject",
    background: "background",
    allowAlways: "allowAlways",
    allowYolo: "allowYolo",
    accept_with_message: { type: "accept_with_message", message: "go" },
    reject_with_message: { type: "reject_with_message", message: "no" },
    question_answers: { type: "question_answers", answers: { q: "a" } },
    allow_always_with_rule: { type: "allow_always_with_rule", rule: "ls *" },
    allow_always_with_rules: {
      type: "allow_always_with_rules",
      rules: ["ls *", "cat *"],
    },
  };
  const requests: PermissionRequest[] = [
    {
      type: "write_file",
      tool: toolRequest("call-1", "write", { path: "a" }),
      displayName: "Create file",
      filePath: "a",
      originalContent: "",
      content: "x",
      isNewFile: true,
    },
    {
      type: "run_terminal",
      tool: toolRequest("call-1", "bash", { command: "ls" }),
      displayName: "Run",
      command: "ls",
      cwd: "/",
      background: false,
    },
    {
      type: "exit_plan_mode",
      tool: toolRequest("call-1", "exit_plan_mode", {}),
      displayName: "Plan",
      planFilePath: "plan.md",
      planContent: "p",
    },
    {
      type: "ask_user_question",
      tool: toolRequest("call-1", "ask_user_question", {}),
      displayName: "Question",
      questions: [],
    },
    sandboxDenied("call-1", "touch /x"),
  ];

  // The session receives the decision through the same respondPermission
  // call either way, so identical compat bytes plus an identical decision
  // at the session mean identical effects (mode change, allowances, rules,
  // question steer, sandbox once/session: applyDecision* are unchanged).
  for (const request of requests) {
    for (const kind of allowedDecisions(request.type)) {
      it(`${request.type} / ${kind}: permission.respond is permission_response`, async () => {
        const answered = async (legacy: boolean) => {
          const s = await scripted(async (api) => {
            await api.ask("perm-1", request);
          });

          s.send({ type: "send", message: "go" });
          await s.waitFor(() => pending(s).length === 1, "card");
          s.send(
            legacy
              ? {
                  type: "permission_response",
                  permissionId: "perm-1",
                  decision: sample[kind],
                }
              : {
                  type: "permission.respond",
                  lineage: lineage(s, "perm-1"),
                  decision: sample[kind],
                }
          );
          await s.waitFor(
            (events) => events.some((event) => event.type === "RUN_FINISHED"),
            "done"
          );
          await s.close();

          return { compat: s.compat(), answers: s.session.answers };
        };
        const viaRespond = await answered(false);
        const viaLegacy = await answered(true);

        expect(viaRespond.compat).toBe(viaLegacy.compat);
        expect(viaRespond.answers).toEqual(viaLegacy.answers);
        expect(viaRespond.answers).toEqual([
          { permissionId: "perm-1", decision: sample[kind] },
        ]);
      });
    }
  }
});

describe("operator user metadata", () => {
  it.each(["send", "run"])(
    "emits a tagged %s without changing model text",
    async (wire) => {
      const text = "operator rules\n\n[Ada] hello";
      const userText = {
        operator: { kind: "auto-reply-intro" as const, visibleFrom: 16 },
      };
      let received = "";
      const s = await scripted(async (api) => {
        received = api.text;
        api.settled();
      });
      try {
        s.send(
          wire === "send"
            ? { type: "send", message: text, userText }
            : {
                ...run("op", text),
                input: {
                  ...run("op", text).input,
                  messages: [
                    {
                      id: "u-op",
                      role: "user",
                      content: text,
                      metadata: { abacus: { userText } },
                    },
                  ],
                },
              }
        );
        await s.waitFor(
          () => s.events().some((e) => e.type === "RUN_FINISHED"),
          "turn finished"
        );
        expect(received).toBe(text);
        const processor = new StreamProcessor();
        for (const event of s.events()) processor.processChunk(event as never);
        const user = processor
          .getMessages()
          .find((message) => message.role === "user");
        expect(user?.metadata?.abacus?.userText).toEqual(userText);
        expect(user?.parts).toEqual([{ type: "text", content: text }]);
      } finally {
        await s.close();
      }
    }
  );
});

it.each([false, true])(
  "preserves operator tags when a busy send is drained or steered (%s)",
  async (landed) => {
    let api: Parameters<Parameters<typeof scripted>[0]>[0] | undefined;
    const s = await scripted(async (turn) => {
      if (turn.index === 1) {
        api = turn;
        await turn.gate("release");
      }
      turn.settled();
    });
    const text = "rules\n\n[Ada] hello";
    const userText = {
      operator: { kind: "auto-reply-reminder" as const, visibleFrom: 7 },
    };
    try {
      s.send({ type: "send", message: "first" });
      await s.waitFor(() => api != null, "first turn held");
      s.send({ type: "send", message: text, userText });
      await s.waitFor(
        () =>
          s
            .custom<{ messages: Array<{ userText?: unknown }> }>(
              "queue.updated"
            )
            .at(-1)?.messages.length === 1,
        "operator queued"
      );
      expect(
        s
          .custom<{ messages: Array<{ userText?: unknown }> }>("queue.updated")
          .at(-1)?.messages[0]?.userText
      ).toEqual(userText);
      if (landed) api!.agent({ type: "user_message_steered", content: text });
      s.session.open("release");
      await s.waitFor(
        () =>
          s
            .events()
            .some(
              (event) =>
                event.type === "TEXT_MESSAGE_CONTENT" &&
                (event as { delta?: string }).delta === text
            ),
        "operator echoed"
      );
      const start = s
        .events()
        .filter(
          (event) =>
            event.type === "TEXT_MESSAGE_START" &&
            (event as { role?: string }).role === "user"
        )
        .at(-1);
      expect(
        (start as { metadata?: { abacus?: { userText?: unknown } } })?.metadata
          ?.abacus?.userText
      ).toEqual(userText);
    } finally {
      s.session.open("release");
      await s.close();
    }
  }
);

it("acknowledges a reaction change and delivers a hidden operator turn verbatim", async () => {
  const s = await scripted(async (api) => {
    api.settled();
  });
  try {
    s.send({
      type: "message.react",
      messageId: "a",
      emoji: "👍",
      selected: true,
      excerpt: "Hello",
    });
    await s.waitFor(
      () => s.events().some((event) => event.type === "RUN_FINISHED"),
      "reaction turn"
    );
    // Main applies the reaction; the agent only hears about the selection.
    expect(s.custom("message.reactions")).toEqual([]);
    expect(s.session.sent).toContain(
      '[reaction] The user reacted 👍 to your message "Hello"'
    );
    const processor = new StreamProcessor();
    for (const event of s.events()) processor.processChunk(event as never);
    expect(
      processor.getMessages().find((message) => message.role === "user")
        ?.metadata?.abacus?.userText
    ).toEqual({ operator: { kind: "user-reaction" } });
    const sent = s.session.sent.length;
    s.send({
      type: "message.react",
      messageId: "a",
      emoji: "👍",
      selected: false,
      excerpt: "Hello",
    });
    s.send({
      type: "message.react",
      messageId: "a",
      emoji: "💥",
      selected: true,
      excerpt: "Hello",
    });
    s.send({
      type: "message.react",
      messageId: "b",
      emoji: "🔥",
      selected: true,
      excerpt: "Again",
    });
    await s.waitFor(
      () => s.session.sent.some((text) => text.includes("🔥")),
      "second reaction note"
    );
    // A withdrawal and an emoji off the list say nothing to the agent.
    expect(s.session.sent.length).toBe(sent + 1);
    expect(s.custom("message.reactions")).toEqual([]);
  } finally {
    await s.close();
  }
});

it("keeps two identical messages apart by their ids: one steered in, the other run as its own turn", async () => {
  let api: Parameters<Parameters<typeof scripted>[0]>[0] | undefined;
  const s = await scripted(async (turn) => {
    if (turn.index === 1) {
      api = turn;
      await turn.gate("release");
    }
    turn.settled();
  });
  try {
    s.send({ type: "send", message: "book it", messageId: "m1" });
    await s.waitFor(() => api != null, "first turn held");
    s.send({ type: "send", message: "ok", messageId: "m2" });
    s.send({ type: "send", message: "ok", messageId: "m3" });
    await s.waitFor(() => s.session.steered.length === 2, "both steered");
    expect(s.session.steeredIds).toEqual(["m2", "m3"]);

    // The second "ok" landed; the first is still on its way.
    api!.agent({
      type: "user_message_steered",
      content: "ok",
      messageId: "m3",
    });
    s.session.open("release");
    await s.waitFor(() => s.session.sent.length === 2, "leftover drained");
    expect(s.session.sentIds).toEqual(["m1", "m2"]);
  } finally {
    s.session.open("release");
    await s.close();
  }
});

it("answers a refresh asked for by id once it is done, or failed", async () => {
  // Main waits on this answer, not on `mcp_servers`, which also goes out
  // while the old clients close and the new ones connect.
  const s = await scripted(async (api) => {
    api.settled();
  });
  try {
    s.send({ type: "mcp_refresh", requestId: "connectors-1" });
    await s.waitFor(
      () => s.compat().includes('"mcp_refreshed"'),
      "refresh answer"
    );
    expect(s.compat()).toContain(
      '{"type":"mcp_refreshed","requestId":"connectors-1"}'
    );

    (s.session as { refreshMcp: () => Promise<void> }).refreshMcp =
      async () => {
        throw new Error("gateway down");
      };
    s.send({ type: "mcp_refresh", requestId: "connectors-2" });
    await s.waitFor(
      () => s.compat().includes('"mcp_refresh_failed"'),
      "refresh failure"
    );
    expect(s.compat()).toMatch(
      /"type":"mcp_refresh_failed","error":"gateway down","requestId":"connectors-2"/
    );
  } finally {
    await s.close();
  }
});
