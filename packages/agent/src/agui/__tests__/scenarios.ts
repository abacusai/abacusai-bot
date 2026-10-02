/**
 * The golden scenarios (spec §7.1). Each is a legacy command script plus the
 * fake provider's replies; `aguiScript` (when present) is the equivalent
 * script under `--wire agui`, using the AG-UI commands whose legacy mapping is
 * in §2.4. Where it is absent the agui run replays the same legacy commands,
 * as main does for everything it originates.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { RecordedCall } from "@abacus-ai/test-support/fake-provider";

import { PROVIDER_DEFAULTS } from "../../config.js";
import type { DesktopEvent } from "../../protocol.js";
import {
  GOLDEN_ROOT,
  isChildCall,
  type Scenario,
  type Step,
} from "./harness.js";

type AgentType = Extract<DesktopEvent, { type: "event" }>["event"]["type"];

const agentEvents = (events: DesktopEvent[], type: AgentType): number =>
  events.filter((event) => event.type === "event" && event.event.type === type)
    .length;

/** Waits until at least `count` agent events of `type` have arrived. */
export const seen = (type: AgentType, count = 1): Step => ({
  until: (events) => agentEvents(events, type) >= count,
  label: `${count} × ${type}`,
});

/** Waits for the host's own idle after a turn (status idle count). */
export const idle = (count = 1): Step => ({
  until: (events) =>
    events.filter(
      (event) =>
        event.type === "event" &&
        event.event.type === "status_changed" &&
        event.event.status === "idle"
    ).length >= count,
  label: `${count} × idle`,
});

export const permission = (count = 1): Step => ({
  until: (events) =>
    events.filter((event) => event.type === "permission_needed").length >=
    count,
  label: `${count} × permission_needed`,
});

export const queueLines = (count: number): Step => ({
  until: (events) =>
    events.filter((event) => event.type === "queue_updated").length >= count,
  label: `${count} × queue_updated`,
});

/** Under agui: pi has opened the assistant message the Stop will cut. */
const assistantStarted: Step = {
  aguiUntil: (stdout) => stdout.includes('"role":"assistant"'),
  label: "assistant message started",
};

export interface GoldenScenario extends Scenario {
  /** Under --wire agui: the script to run instead of `steps`. */
  aguiSteps?: Step[];
}

// ------------------------------------------------ AG-UI command builders

type Loose = { type: string; name?: string; value?: unknown; runId?: string };

const aguiEvents = (stdout: string): Loose[] =>
  stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Loose);

/** The run id of the newest RUN_STARTED. */
const openRunId = (stdout: string): string | undefined =>
  aguiEvents(stdout)
    .filter((event) => event.type === "RUN_STARTED")
    .at(-1)?.runId;

/** A pending permission's lineage, as the renderer reads it from the store. */
const lineageOf = (stdout: string, permissionId: string): unknown => {
  const pending = aguiEvents(stdout)
    .filter(
      (event) => event.type === "CUSTOM" && event.name === "permission.pending"
    )
    .at(-1)?.value as
    | {
        items: Array<{
          id: string;
          metadata: { abacus: { lineage: unknown } };
        }>;
      }
    | undefined;
  const item = pending?.items.find((entry) => entry.id === permissionId);

  if (item == null) throw new Error(`${permissionId} is not pending`);

  return item.metadata.abacus.lineage;
};

/** The renderer's answer: `permission.respond` with the descriptor's lineage. */
const respond = (permissionId: string, decision: unknown): Step => ({
  sendFrom: (stdout) => ({
    type: "permission.respond",
    lineage: lineageOf(stdout, permissionId),
    decision,
  }),
  label: `permission.respond ${permissionId}`,
});

/** The renderer's Stop: `cancel` naming the open run. */
const cancelOpenRun: Step = {
  sendFrom: (stdout) => ({ type: "cancel", runId: openRunId(stdout) }),
  label: "cancel the open run",
};

/** Every provider key blanked, so only the scenario's config decides. */
const NO_KEYS: Record<string, string> = Object.fromEntries([
  ...PROVIDER_DEFAULTS.map((entry) => [entry.envVar, ""]),
  ["ROUTELLM_API_KEY", ""],
]);

/** No pi retries, so a scripted failure reaches the agent's own recovery. */
const noPiRetries = (home: string): void => {
  fs.mkdirSync(path.join(home, "agent"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "agent", "settings.json"),
    JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } })
  );
};

/** An OpenLLM pool of two models, both served by the fake provider. */
const openLlmPool = ({ home }: { home: string }): void => {
  const config = JSON.parse(
    fs.readFileSync(path.join(home, "config.json"), "utf8")
  ) as { customProviders: Array<{ baseUrl: string }> };

  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      defaultModel: "openllm/auto",
      customProviders: [
        {
          id: "openrouter",
          baseUrl: config.customProviders[0]!.baseUrl,
          apiKey: "test-key",
          models: [
            { id: "big:free", contextWindow: 131072 },
            { id: "small:free", contextWindow: 65536 },
          ],
        },
      ],
    })
  );
  noPiRetries(home);
};

const BOT_DIR = path.join(GOLDEN_ROOT, "home", "bots", "bot-1");

const hasToolResult = (call: RecordedCall): boolean =>
  call.messages.some((message) => message.role === "tool");

const YOLO = "yolo";

export const SCENARIOS: GoldenScenario[] = [
  {
    name: "plain-text",
    reply: () => ({ say: "Hello there." }),
    steps: [{ send: { type: "send", message: "hi" } }, idle(2)],
    aguiSteps: [
      {
        send: {
          type: "run",
          input: {
            threadId: "t-1",
            runId: "run-1",
            messages: [{ id: "u-1", role: "user", content: "hi" }],
            tools: [],
            context: [],
            state: {},
          },
        },
      },
      idle(2),
    ],
  },
  {
    name: "tool-bash",
    mode: YOLO,
    reply: (index) =>
      index === 0
        ? {
            say: "Let me check.",
            call: { name: "bash", args: { command: "echo golden" } },
          }
        : { say: "All good." },
    steps: [{ send: { type: "send", message: "run it" } }, idle(2)],
  },
  {
    name: "todo-plan",
    mode: YOLO,
    reply: (index) =>
      index === 0
        ? {
            call: {
              name: "todo",
              args: {
                action: "set",
                todos: [
                  { content: "  first  ", status: "in_progress" },
                  { content: "second", status: "pending" },
                ],
              },
            },
          }
        : { say: "Planned." },
    steps: [{ send: { type: "send", message: "plan" } }, idle(2)],
  },
  {
    name: "permission-accept",
    reply: (index) =>
      index === 0
        ? {
            call: {
              name: "write",
              args: { path: "a.txt", content: "hello\n" },
            },
          }
        : { say: "Wrote it." },
    steps: [
      { send: { type: "send", message: "write a file" } },
      permission(1),
      {
        send: {
          type: "permission_response",
          permissionId: "perm-1",
          decision: "accept",
        },
      },
      idle(2),
    ],
    // The renderer's answer: same compat bytes as the legacy response.
    aguiSteps: [
      { send: { type: "send", message: "write a file" } },
      permission(1),
      respond("perm-1", "accept"),
      idle(2),
    ],
  },
  {
    name: "permission-reject-message",
    reply: (index) =>
      index === 0
        ? {
            call: {
              name: "write",
              args: { path: "b.txt", content: "nope\n" },
            },
          }
        : { say: "Understood." },
    steps: [
      { send: { type: "send", message: "write b" } },
      permission(1),
      {
        send: {
          type: "permission_response",
          permissionId: "perm-1",
          decision: { type: "reject_with_message", message: "not now" },
        },
      },
      idle(2),
    ],
    aguiSteps: [
      { send: { type: "send", message: "write b" } },
      permission(1),
      respond("perm-1", { type: "reject_with_message", message: "not now" }),
      idle(2),
    ],
  },
  {
    // pi runs the gate for sibling calls one after another, so the second
    // card goes up once the first is answered.
    name: "permission-two-calls",
    reply: (index) =>
      index === 0
        ? {
            calls: [
              { name: "write", args: { path: "one.txt", content: "1\n" } },
              { name: "write", args: { path: "two.txt", content: "2\n" } },
            ],
          }
        : { say: "Both done." },
    steps: [
      { send: { type: "send", message: "write two" } },
      permission(1),
      {
        send: {
          type: "permission_response",
          permissionId: "perm-1",
          decision: "accept",
        },
      },
      permission(2),
      {
        send: {
          type: "permission_response",
          permissionId: "perm-2",
          decision: "reject",
        },
      },
      idle(2),
    ],
    aguiSteps: [
      { send: { type: "send", message: "write two" } },
      permission(1),
      respond("perm-1", "accept"),
      permission(2),
      // Main's browser auto-allow still answers with the legacy command on
      // an agui runtime: both paths in one run, same compat bytes.
      {
        send: {
          type: "permission_response",
          permissionId: "perm-2",
          decision: "reject",
        },
      },
      idle(2),
    ],
  },
  {
    name: "stop-mid-stream",
    reply: (index) => (index === 0 ? { stall: {} } : { say: "unused" }),
    steps: [
      { send: { type: "send", message: "long answer" } },
      { calls: 1 },
      seen("status_changed", 2),
      assistantStarted,
      { send: { type: "stop" } },
      idle(2),
    ],
    aguiSteps: [
      { send: { type: "send", message: "long answer" } },
      { calls: 1 },
      seen("status_changed", 2),
      assistantStarted,
      cancelOpenRun,
      idle(2),
    ],
  },
  {
    name: "steer-and-queue",
    reply: (index, gates) =>
      index === 0
        ? gates.wait("first").then(() => ({ say: "First answer." }))
        : { say: `Answer ${index}.` },
    steps: [
      { send: { type: "send", message: "first" } },
      { calls: 1 },
      { send: { type: "enqueue", message: "second", hidden: false } },
      queueLines(1),
      { send: { type: "get_queue" } },
      queueLines(2),
      { send: { type: "update_queue_item", index: 0, message: "second!" } },
      queueLines(3),
      { release: "first" },
      idle(2),
    ],
  },
  {
    name: "queue-remove-clear",
    reply: (index, gates) =>
      index === 0
        ? gates.wait("first").then(() => ({ say: "Done." }))
        : { say: `Answer ${index}.` },
    steps: [
      { send: { type: "send", message: "first" } },
      { calls: 1 },
      { send: { type: "enqueue", message: "a", hidden: false } },
      queueLines(1),
      { send: { type: "enqueue", message: "b", hidden: false } },
      queueLines(2),
      { send: { type: "remove_from_queue", index: 0 } },
      queueLines(3),
      { send: { type: "clear_queue" } },
      queueLines(4),
      { release: "first" },
      idle(2),
    ],
  },
  {
    name: "stop-then-message",
    reply: (index) => (index === 0 ? { stall: {} } : { say: "After stop." }),
    steps: [
      { send: { type: "send", message: "slow" } },
      { calls: 1 },
      assistantStarted,
      { send: { type: "stop" } },
      { send: { type: "send", message: "again" } },
      { calls: 2 },
      idle(3),
    ],
    aguiSteps: [
      { send: { type: "send", message: "slow" } },
      { calls: 1 },
      assistantStarted,
      cancelOpenRun,
      { send: { type: "send", message: "again" } },
      { calls: 2 },
      idle(3),
    ],
  },
  {
    name: "malformed-command",
    reply: () => ({ say: "ok" }),
    steps: [
      { send: "{not json" },
      seen("error", 1),
      { send: { type: "set_mode", mode: "sideways" } },
      seen("mode_changed", 2),
      { send: { type: "set_model", model: "nope/missing" } },
      seen("error", 2),
    ],
  },
  {
    name: "turn-failed",
    reply: () => ({ fail: { status: 400, message: "bad request from fake" } }),
    steps: [
      { send: { type: "send", message: "fail please" } },
      seen("error", 1),
      idle(2),
    ],
  },
  {
    name: "reset-conversation",
    reply: () => ({ say: "Fresh." }),
    steps: [
      { send: { type: "send", message: "hi" } },
      idle(2),
      { send: { type: "reset_conversation" } },
      seen("segments_cleared", 1),
      { send: { type: "send", message: "again" } },
      idle(4),
    ],
  },
  {
    name: "dequeue-idle",
    reply: (index) =>
      index === 0 ? { stall: {} } : { say: `Answer ${index}.` },
    steps: [
      { send: { type: "send", message: "slow" } },
      { calls: 1 },
      assistantStarted,
      { send: { type: "stop" } },
      idle(2),
      { send: { type: "dequeue" } },
      queueLines(2),
      { send: { type: "send", message: "next" } },
      idle(3),
    ],
  },
  // ---------------------------------------------------------------- r1 fixes
  {
    // Codex impl r1 #1: valid JSON that is not a command. The legacy host
    // reported the handler's TypeError and kept going.
    name: "null-line",
    reply: () => ({ say: "Still here." }),
    steps: [
      { send: "null" },
      seen("error", 1),
      { send: { type: "send", message: "after null" } },
      idle(2),
    ],
  },
  {
    // Codex impl r1 #13: Stop lands after a real text delta on both wires.
    name: "stop-after-text",
    reply: (index) =>
      index === 0 ? { stall: { say: "Partial answer" } } : { say: "unused" },
    steps: [
      { send: { type: "send", message: "long answer" } },
      seen("text_delta", 1),
      { send: { type: "stop" } },
      idle(2),
    ],
    aguiSteps: [
      { send: { type: "send", message: "long answer" } },
      seen("text_delta", 1),
      cancelOpenRun,
      idle(2),
    ],
  },
  {
    // Claude impl r1 #10: a reset while a reply is streaming.
    name: "reset-mid-run",
    reply: (index) =>
      index === 0 ? { stall: { say: "Working on it" } } : { say: "Fresh." },
    steps: [
      { send: { type: "send", message: "hi" } },
      seen("text_delta", 1),
      { send: { type: "reset_conversation" } },
      seen("segments_cleared", 1),
      { send: { type: "send", message: "again" } },
      { calls: 2 },
      seen("turn_complete", 1),
      idle(3),
    ],
  },
  {
    // §7.1 OpenLLM rotation: the first pool model fails, the turn moves on.
    name: "openllm-rotation",
    mode: YOLO,
    env: NO_KEYS,
    setup: openLlmPool,
    reply: (index) =>
      index === 0
        ? { fail: { status: 429, message: "rate limited upstream" } }
        : { say: "recovered on the second model" },
    steps: [{ send: { type: "send", message: "hi" } }, idle(2)],
  },
  {
    // §7.1 OpenLLM rotation, exhausted: a turn-origin error from rotation.
    name: "openllm-exhausted",
    mode: YOLO,
    env: NO_KEYS,
    setup: openLlmPool,
    reply: () => ({ fail: { status: 429, message: "rate limited upstream" } }),
    steps: [
      { send: { type: "send", message: "hi" } },
      seen("error", 1),
      idle(2),
    ],
  },
  {
    // §7.1 continuation recovery: a model call that goes silent is abandoned
    // and the turn continues on a continuation prompt.
    name: "stall-recovery",
    mode: YOLO,
    env: { ABACUSAI_BOT_MODEL_STALL_MS: "700" },
    reply: (index) =>
      index === 0
        ? { stall: { say: "Starting" } }
        : { say: "finished after all" },
    steps: [{ send: { type: "send", message: "hi" } }, idle(2)],
  },
  {
    // The continuation stalls too: the stall's turn-origin error.
    name: "stall-twice",
    mode: YOLO,
    env: { ABACUSAI_BOT_MODEL_STALL_MS: "700" },
    reply: () => ({ stall: { say: "Starting" } }),
    steps: [
      { send: { type: "send", message: "hi" } },
      seen("error", 1),
      idle(2),
    ],
  },
  {
    // §7.1 bot: <think> + <reply>, then a hidden consolidation turn.
    name: "bot-housekeeping",
    env: { ABACUSAI_BOT_BOT_DIR: BOT_DIR, PI_OFFLINE: "1" },
    setup: () => {
      // A daily note makes the consolidation turn due after this reply.
      fs.mkdirSync(path.join(BOT_DIR, "memory"), { recursive: true });
      fs.writeFileSync(
        path.join(BOT_DIR, "memory", "2026-01-01.md"),
        "- met the user\n"
      );
    },
    reply: (index) =>
      index === 0
        ? { say: "<think>pondering</think><reply>Hi there</reply>" }
        : { say: "NO_REPLY" },
    steps: [
      { send: { type: "send", message: "hello bot" } },
      { calls: 2 },
      idle(2),
    ],
  },
  {
    // §7.1 bot no-model: the bot has nothing to run on when the user writes.
    name: "bot-no-model",
    env: { ...NO_KEYS, ABACUSAI_BOT_BOT_DIR: BOT_DIR, PI_OFFLINE: "1" },
    setup: ({ home }) => {
      fs.mkdirSync(BOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(home, "config.json"), "{}");
    },
    reply: () => ({ say: "unused" }),
    // The startup model_unavailable, then the send's; the send never became
    // a turn, so the host's own idle is the only one.
    steps: [
      { send: { type: "send", message: "hello bot" } },
      seen("error", 2),
      idle(1),
    ],
  },
  {
    // §7.1 two parallel delegates whose children reuse one provider id. The
    // second child's first model call is held until the first child ended,
    // so the interleaving (and the bytes) are fixed.
    name: "delegate-colliding-ids",
    mode: YOLO,
    collidingChildIds: true,
    respond: async (call, _index, gates) => {
      if (isChildCall(call)) {
        const second = call.userText.some((text) => text.includes("task B"));

        if (hasToolResult(call)) {
          return { say: second ? "B looked." : "A looked." };
        }
        if (second) await gates.wait("child-b");

        return { call: { name: "ls", args: { path: "." } } };
      }

      return hasToolResult(call)
        ? { say: "Both delegates reported." }
        : {
            calls: [
              { name: "delegate_task", args: { task: "task A: list files" } },
              { name: "delegate_task", args: { task: "task B: list files" } },
            ],
          };
    },
    steps: [
      { send: { type: "send", message: "delegate twice" } },
      seen("subtask_end", 1),
      { release: "child-b" },
      seen("subtask_end", 2),
      idle(2),
    ],
  },
];
