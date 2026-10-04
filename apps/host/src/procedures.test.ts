import { afterAll, expect, it, vi } from "vitest";
const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "host-procedures-"));
  process.env.ABACUSAI_BOT_HOME = home;
  process.env.ABACUSAI_BOT_HOST_MODE = "1";
  delete process.env.ABACUS_API_KEY;
  return { home };
});
import { rmSync } from "node:fs";

import * as v from "valibot";

import { supportsProcedure } from "#main/platform/capabilities";
import { createRouter } from "#main/rpc/router";
import { connectInProcess } from "#main/rpc/testing";

import { composeNodeHost } from "./compose";
import { procedureInput } from "./procedure-input.test-support";
const procedures = (
  router: any,
  prefix: string[] = []
): Array<{ path: string[]; procedure: any }> =>
  Object.entries(router).flatMap(([name, value]: [string, any]) =>
    value?.["~orpc"]?.handler
      ? [{ path: [...prefix, name], procedure: value }]
      : value && typeof value === "object"
        ? procedures(value, [...prefix, name])
        : []
  );
it("calls every retained procedure under the shim through a memory transport", async () => {
  vi.stubGlobal(
    "fetch",
    async () => new Response("offline fixture", { status: 403 })
  );
  const host = await composeNodeHost();
  const transport = connectInProcess(host.deps, {
    platform: "web-host",
    windowKind: "web",
    webContentsId: null,
  });
  const failures: string[] = [];
  const retained = procedures(createRouter()).filter(({ path, procedure }) =>
    supportsProcedure(
      "web-host",
      path.join("."),
      procedureInput(procedure["~orpc"].inputSchema, fixture.home)
    )
  );
  let called = 0;
  try {
    for (const { path, procedure } of retained) {
      const name = path.join(".");
      const schema = procedure["~orpc"].inputSchema;
      let input = procedureInput(schema, fixture.home);
      if (name === "auth.web.complete") input = { code: "fixture" };
      const parsed =
        schema?.kind === "schema"
          ? v.safeParse(schema, input)
          : await schema?.["~standard"]?.validate(input);
      if (parsed?.issues?.length) {
        failures.push(
          `${name}: invalid fixture ${JSON.stringify(parsed.issues)}`
        );
        continue;
      }
      called++;
      let client: any = transport.client;
      for (const segment of path) client = client[segment];
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 100);
      try {
        const value = await client(input, { signal: abort.signal });
        if (value && typeof value.next === "function") {
          try {
            await value.next();
          } finally {
            abort.abort();
            await value.return?.();
          }
        }
      } catch (error) {
        const message = String((error as Error).message);
        // Missing ids and offline network calls have normal domain errors. Electron use is never one.
        if (
          (error as { code?: string }).code === "INTERNAL_SERVER_ERROR" ||
          /Electron member|HostUnsupportedError|not available.*shim|Input validation failed/.test(
            message
          )
        )
          failures.push(`${name}: ${message}`);
      } finally {
        clearTimeout(timer);
      }
    }
    expect(called).toBe(retained.length);
    expect(called).toBeGreaterThan(150);
    console.info(`Retained procedures exercised: ${called}`);
    expect(failures).toEqual([]);
  } finally {
    transport.closeClient();
    transport.closeServer();
    await host.dispose();
    vi.unstubAllGlobals();
  }
}, 60_000);
afterAll(() => rmSync(fixture.home, { recursive: true, force: true }));
