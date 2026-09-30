/**
 * `--wire agui` (spec §7.1-§7.2), in process against the fake provider:
 *
 * - the compatibility stream equals `--wire ndjson`'s stdout for the same
 *   scenario byte for byte (after the same volatile-value mask the ndjson
 *   golden uses), and so equals the pre-change baseline;
 * - the AG-UI stream is well formed (§7.4) and matches its golden fixture.
 */
import { afterAll, describe, expect, it } from "vitest";

import {
  aguiDriver,
  drive,
  golden,
  lines,
  maskVolatile,
  normalizeAgui,
  prepare,
  readGolden,
  stopProvider,
} from "./__tests__/harness.js";
import { violations } from "./__tests__/invariants.js";
import { SCENARIOS } from "./__tests__/scenarios.js";
import { AguiHost } from "./host.js";
import type { AguiEvent } from "./wire.js";

afterAll(async () => {
  await stopProvider();
});

describe("--wire agui", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const { context, provider, gates, restore } = await prepare(scenario);

      try {
        const host = aguiDriver(
          (io) =>
            new AguiHost({
              cwd: context.cwd,
              ...(context.mode != null ? { mode: context.mode } : {}),
              threadId: "t-1",
              incarnation: "inc-1",
              compat: { mode: "fd", write: io.compatWrite },
              stdin: io.stdin,
              writeStdout: io.writeStdout,
              exit: () => undefined,
              log: () => undefined,
            })
        );

        await drive(
          { ...scenario, steps: scenario.aguiSteps ?? scenario.steps },
          host,
          provider,
          gates
        );

        // Compat carries today's NDJSON, byte for byte.
        const compat = maskVolatile(host.bytes(), provider.port);

        expect(compat).toBe(readGolden(`${scenario.name}.ndjson`));

        // stdout is AG-UI only, and well formed.
        const events = lines(host.stdout()).map(
          (line) => JSON.parse(line) as AguiEvent
        );

        expect(violations(events)).toEqual([]);

        const normalized = normalizeAgui(host.stdout(), provider.port);

        expect(normalized).toBe(
          golden(`${scenario.name}.agui.jsonl`, normalized) ?? normalized
        );
      } finally {
        restore();
      }
    });
  }
});
