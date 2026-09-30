/**
 * `--wire ndjson` is unchanged (spec §7.2 step 4): the production NdjsonHost,
 * driven through process stdio, writes exactly the bytes recorded from the
 * pre-change build for every scenario. Run with UPDATE_GOLDENS=1 only on a
 * build whose NDJSON output is known to be the baseline.
 */
import { afterAll, describe, expect, it } from "vitest";

import { NdjsonHost } from "../host.js";
import {
  drive,
  golden,
  maskVolatile,
  ndjsonDriver,
  prepare,
  stopProvider,
} from "./__tests__/harness.js";
import { SCENARIOS } from "./__tests__/scenarios.js";

afterAll(async () => {
  await stopProvider();
});

describe("--wire ndjson stdout equals the pre-change baseline", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const { context, provider, gates, restore } = await prepare(scenario);

      try {
        const host = ndjsonDriver(
          (ctx) =>
            new NdjsonHost({
              cwd: ctx.cwd,
              ...(ctx.mode != null ? { mode: ctx.mode } : {}),
            }),
          context
        );

        await drive(scenario, host, provider, gates);

        const bytes = maskVolatile(host.bytes(), provider.port);
        const baseline = golden(`${scenario.name}.ndjson`, bytes);

        if (baseline != null) expect(bytes).toBe(baseline);
      } finally {
        restore();
      }
    });
  }
});
