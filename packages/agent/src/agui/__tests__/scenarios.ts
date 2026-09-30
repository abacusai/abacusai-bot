/**
 * The golden scenarios (spec §7.1). Each is a legacy command script plus the
 * fake provider's replies; `aguiScript` (when present) is the equivalent
 * script under `--wire agui`, using the AG-UI commands whose legacy mapping is
 * in §2.4. Where it is absent the agui run replays the same legacy commands,
 * as main does for everything it originates.
 */
import type { DesktopEvent } from "../../protocol.js";
import type { Scenario, Step } from "./harness.js";

type AgentType = Extract<DesktopEvent, { type: "event" }>["event"]["type"];

const agentEvents = (events: DesktopEvent[], type: AgentType): number =>
  events.filter(
    (event) => event.type === "event" && event.event.type === type
  ).length;

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

export interface GoldenScenario extends Scenario {
  /** Under --wire agui: the script to run instead of `steps`. */
  aguiSteps?: Step[];
}

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
  },
  {
    name: "stop-mid-stream",
    reply: (index) =>
      index === 0
        ? { stall: {} }
        : { say: "unused" },
    steps: [
      { send: { type: "send", message: "long answer" } },
      { calls: 1 },
      seen("status_changed", 2),
      { send: { type: "stop" } },
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
    reply: (index) =>
      index === 0
        ? { stall: {} }
        : { say: "After stop." },
    steps: [
      { send: { type: "send", message: "slow" } },
      { calls: 1 },
      { send: { type: "stop" } },
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
      index === 0
        ? { stall: {} }
        : { say: `Answer ${index}.` },
    steps: [
      { send: { type: "send", message: "slow" } },
      { calls: 1 },
      { send: { type: "stop" } },
      idle(2),
      { send: { type: "dequeue" } },
      queueLines(2),
      { send: { type: "send", message: "next" } },
      idle(3),
    ],
  },
];
