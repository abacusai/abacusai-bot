/**
 * `--wire ndjson` is unchanged (spec §7.2 step 4): the production NdjsonHost,
 * driven through process stdio, writes exactly the bytes recorded from the
 * pre-change build for every scenario.
 *
 * The baselines are read-only here. `RECORD_NDJSON_BASELINE=1` writes a
 * missing one and never overwrites an existing one; it is only ever run on a
 * checkout of the pre-change host (d9cf445e) with this harness copied in, so
 * every baseline is the legacy host's own output (see the r1 fix log).
 */
import * as fs from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { NdjsonHost } from "../host.js";
import {
  drive,
  fixturePath,
  maskVolatile,
  ndjsonDriver,
  prepare,
  readGolden,
  stopProvider,
} from "./__tests__/harness.js";
import { SCENARIOS } from "./__tests__/scenarios.js";

afterAll(async () => {
  await stopProvider();
});

describe("--wire ndjson stdout equals the pre-change baseline", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const { context, provider, ports, gates, restore } =
        await prepare(scenario);

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

        const bytes = maskVolatile(host.bytes(), ports);
        const file = fixturePath(`${scenario.name}.ndjson`);

        if (
          process.env.RECORD_NDJSON_BASELINE === "1" &&
          !fs.existsSync(file)
        ) {
          fs.writeFileSync(file, bytes);
        }

        expect(bytes).toBe(readGolden(`${scenario.name}.ndjson`));
      } finally {
        restore();
      }
    });
  }
});
