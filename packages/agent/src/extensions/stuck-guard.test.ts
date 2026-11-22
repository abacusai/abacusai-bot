import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { AguiEmitter } from "../agui/emit.js";
import { RunController } from "../agui/runs.js";
import { HostSink } from "../agui/sink.js";
import type { AguiEvent } from "../agui/wire.js";
import { OwnedTurn } from "../owned-turn.js";
import { createStuckGuard, judgeComplaint } from "./stuck-guard.js";

type Handler = (event: unknown, ctx?: unknown) => unknown;

/** The guard on a fake pi: its handlers, driven one turn at a time. */
function guardRig(verdict: boolean | null) {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  const judged: string[] = [];
  let owned = new OwnedTurn();
  createStuckGuard(
    async (ask) => {
      judged.push(ask);
      return verdict;
    },
    (complained) => owned.noteComplaint(complained)
  )(pi);
  const fire = async (name: string, event: unknown = {}) =>
    await handlers.get(name)?.(event, { cwd: "/" });
  /** One turn: the user's message, a shell command, the reply, settled. */
  const turn = async (prompt: string): Promise<OwnedTurn> => {
    owned = new OwnedTurn();
    await fire("before_agent_start", { prompt });
    await fire("tool_result", {
      toolName: "bash",
      isError: false,
      content: [],
      input: {},
    });
    await fire("agent_end", {
      messages: [{ role: "assistant", content: "Done: it works now." }],
    });
    await fire("agent_settled");
    return owned;
  };
  return { judged, turn };
}

/** The agent's AG-UI emitter with one run open, as the host drives it. */
function emitterRig() {
  const out: AguiEvent[] = [];
  const sink = new HostSink({ mode: "fd", write: () => undefined });
  const runs: RunController = new RunController({
    threadId: "t-1",
    write: (event) => sink.writeAgui(event),
    closeOpenParts: () => emitter.closeOpenParts(),
    model: () => emitter.model(),
    onOpen: () => emitter.runOpened(),
  });
  const emitter: AguiEmitter = new AguiEmitter({
    threadId: "t-1",
    incarnation: "inc-1",
    runs,
    approvalTimeoutMs: () => Number.POSITIVE_INFINITY,
    now: () => 0,
    log: () => undefined,
  });
  sink.attach({
    emitter,
    runs,
    write: (line) => out.push(JSON.parse(line) as AguiEvent),
  });
  const token = runs.mint("run-1");
  runs.open(token, "run-1", { serverInitiated: false });
  runs.setCurrent(token);
  return { out, sink, runs, token };
}

/** The verdict the run's RUN_FINISHED carries, once the owned turn closes. */
const finishedVerdict = (owned: OwnedTurn): unknown => {
  const r = emitterRig();
  owned.hold((outcome) =>
    r.sink.emit({ type: "event", event: { type: "turn_complete", outcome } })
  );
  owned.close(false);
  r.runs.settle(r.token);
  const finished = r.out.find((event) => event.type === "RUN_FINISHED") as
    | { metadata?: { abacus?: { complained?: unknown } } }
    | undefined;
  expect(finished).toBeDefined();
  return finished?.metadata?.abacus?.complained;
};

describe("stuck guard verdict on the turn's outcome", () => {
  it.each<[string, boolean | null, boolean | undefined]>([
    ["a complaint", true, true],
    ["no complaint", false, false],
    ["no answer from the judge", null, undefined],
  ])("%s rides RUN_FINISHED", async (_, verdict, carried) => {
    const rig = guardRig(verdict);
    // The first turn ran work: nothing before it to judge.
    const first = await rig.turn("Build the game");
    expect(rig.judged).toEqual([]);
    expect(first.outcome(false)).toEqual({ kind: "reply" });

    const second = await rig.turn("u didnt do all of it. so stop lying");
    expect(rig.judged).toEqual(["u didnt do all of it. so stop lying"]);
    expect(second.outcome(false).complained).toBe(carried);
    expect(finishedVerdict(second)).toBe(carried);
  });

  it("drops a verdict that lands after the turn closed", () => {
    const owned = new OwnedTurn();
    owned.close(false);
    owned.noteComplaint(true);
    expect(owned.outcome(false)).toEqual({ kind: "reply" });
  });
});

describe("judgeComplaint", () => {
  const answering = (content: unknown, ok = true) =>
    (async () =>
      ({
        ok,
        json: async () => ({ choices: [{ message: { content } }] }),
      }) as Response) as unknown as typeof fetch;

  it.each<[string, typeof fetch, string, boolean | null]>([
    ["A", answering("A"), "key", true],
    ["B", answering("B."), "key", false],
    ["neither letter", answering("maybe"), "key", null],
    ["a failed call", answering("A", false), "key", null],
    ["no key", answering("A"), "", null],
  ])("%s", async (_, fetchImpl, key, expected) => {
    expect(await judgeComplaint("still broken", "Done.", key, fetchImpl)).toBe(
      expected
    );
  });
});
