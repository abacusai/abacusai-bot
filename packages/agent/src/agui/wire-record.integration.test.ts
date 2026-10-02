/**
 * `ABACUSAI_BOT_WIRE_RECORD` (spec §6.3, §7.1 step 1), and why the goldens
 * can be produced live (reviews/00-agent-agui.impl-fixes-r1.md, Codex r1 #8):
 *
 * - recording leaves stdout byte-identical to the pre-change baseline;
 * - the recording holds every stdin line, every legacy event pre-strip (with
 *   its internal facts), and every internal event, in order, and its `out`
 *   events serialise back to stdout exactly;
 * - the internal events a `--wire agui` host's session produces for the same
 *   scenario are the recorded ones. So the AG-UI golden, computed live from
 *   the session whose compat bytes equal the baseline, is computed from the
 *   same event stream a replay of the recording would feed the emitter.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { NdjsonHost } from "../host.js";
import type { InternalAgentEvent } from "../internal-events.js";
import { AbacusBotSession } from "../session.js";
import {
  aguiDriver,
  drive,
  lines,
  maskVolatile,
  ndjsonDriver,
  prepare,
  readGolden,
  stopProvider,
} from "./__tests__/harness.js";
import { SCENARIOS } from "./__tests__/scenarios.js";
import { AguiHost } from "./host.js";
import { readWireRecording, WIRE_RECORD_ENV } from "./record.js";

afterAll(async () => {
  await stopProvider();
});

/** Session ids and pi timestamps differ between two runs by construction. */
const stable = (events: InternalAgentEvent[], ports: number[]): string =>
  maskVolatile(
    events.map((event) => JSON.stringify(event)).join("\n"),
    ports
  ).replace(/"messageId":"[^"]*:\d{13}"/g, '"messageId":"<pi-message>"');

const RECORDED = [
  "tool-bash",
  "todo-plan",
  "permission-accept",
  "turn-failed",
  "delegate-colliding-ids",
];

describe("ABACUSAI_BOT_WIRE_RECORD", () => {
  for (const name of RECORDED) {
    const scenario = SCENARIOS.find((candidate) => candidate.name === name)!;

    it(`${name}: records beside an unchanged stdout, and records what the agui host's emitter is fed`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wire-record-"));
      const file = path.join(dir, "record.jsonl");

      // --wire ndjson, recording.
      const recorded = await prepare(scenario);
      let bytes: string;

      process.env[WIRE_RECORD_ENV] = file;
      try {
        const host = ndjsonDriver(
          (ctx) =>
            new NdjsonHost({
              cwd: ctx.cwd,
              ...(ctx.mode != null ? { mode: ctx.mode } : {}),
            }),
          recorded.context
        );

        await drive(scenario, host, recorded.provider, recorded.gates);
        bytes = host.bytes();
      } finally {
        delete process.env[WIRE_RECORD_ENV];
        recorded.restore();
      }

      expect(maskVolatile(bytes, recorded.ports)).toBe(
        readGolden(`${name}.ndjson`)
      );

      const entries = readWireRecording(fs.readFileSync(file, "utf8"));
      const out = entries.filter((entry) => entry.dir === "out");

      // Pre-strip: stripping (serialising) the recorded events is stdout.
      expect(
        out.map((entry) => `${JSON.stringify(entry.event)}\n`).join("")
      ).toBe(bytes);
      // Every stdin line the script wrote.
      expect(
        entries
          .filter((entry) => entry.dir === "in")
          .map((entry) => (entry as { line: string }).line)
      ).toEqual(
        scenario.steps
          .filter((step) => "send" in step)
          .map((step) => {
            const sent = (step as { send: unknown }).send;

            return typeof sent === "string" ? sent : JSON.stringify(sent);
          })
      );
      // The internal facts ride beside the events that carry them.
      const internals = entries
        .filter((entry) => entry.dir === "internal")
        .map((entry) => entry.event as InternalAgentEvent);

      expect(internals.some((event) => event.type === "message_open")).toBe(
        true
      );
      if (name === "turn-failed") {
        expect(
          out.some(
            (entry) =>
              entry.dir === "out" &&
              entry.event.type === "event" &&
              entry.event.event.type === "error" &&
              entry.meta?.origin === "turn"
          )
        ).toBe(true);
      }
      if (name === "delegate-colliding-ids") {
        expect(
          out.filter(
            (entry) =>
              entry.dir === "out" &&
              typeof entry.meta?.subagentRunId === "string"
          ).length
        ).toBeGreaterThan(0);
      }

      // --wire agui, same scenario: its session feeds the emitter the same
      // internal events (the legacy ones are compat, already byte-equal).
      const live = await prepare(scenario);
      const seen: InternalAgentEvent[] = [];

      try {
        const host = aguiDriver(
          (io) =>
            new AguiHost({
              cwd: live.context.cwd,
              ...(live.context.mode != null ? { mode: live.context.mode } : {}),
              threadId: "t-1",
              incarnation: "inc-1",
              compat: { mode: "fd", write: io.compatWrite },
              stdin: io.stdin,
              writeStdout: io.writeStdout,
              exit: () => undefined,
              log: () => undefined,
              session: (init) =>
                new AbacusBotSession({
                  ...init,
                  emitInternal: (event) => {
                    // As the recorder does: serialised at the moment it is emitted.
                    seen.push(structuredClone(event));
                    init.emitInternal(event);
                  },
                }),
            })
        );

        await drive(
          { ...scenario, steps: scenario.aguiSteps ?? scenario.steps },
          host,
          live.provider,
          live.gates
        );
        expect(maskVolatile(host.bytes(), live.ports)).toBe(
          readGolden(`${name}.ndjson`)
        );
        expect(lines(host.stdout()).length).toBeGreaterThan(0);
      } finally {
        live.restore();
      }

      expect(stable(seen, live.ports)).toBe(stable(internals, recorded.ports));
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
});
