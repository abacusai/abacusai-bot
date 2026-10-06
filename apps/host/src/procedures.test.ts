import { afterAll, expect, it, vi } from "vitest";
const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "host-procedures-"));
  process.env.ABACUSAI_BOT_HOME = home;
  delete process.env.ABACUS_API_KEY;
  return { home, unsupported: [] as string[] };
});
vi.mock("./unsupported", async (importOriginal) => {
  const original = await importOriginal<typeof import("./unsupported")>();
  return {
    ...original,
    HostUnsupportedError: class extends original.HostUnsupportedError {
      constructor(member: string) {
        super(member);
        fixture.unsupported.push(member);
      }
    },
  };
});
import { rmSync } from "node:fs";

import * as v from "valibot";

import { supportsProcedure } from "#main/platform/capabilities";
import { createRouter } from "#main/rpc/router";
import { connectInProcess } from "#main/rpc/testing";

import { composeNodeHost } from "./compose";
import { procedureInput } from "./procedure-input.test-support";
const expectedFailures: Record<string, { code: string; message: string }> = {
  "workspaces.switch": {
    code: "NOT_FOUND",
    message: "No workspace fixture",
  },
  "workspaces.relocate": {
    code: "NOT_FOUND",
    message: "No workspace fixture",
  },
  "git.switchBranch": {
    code: "CONFLICT",
    message: "Unable to switch git branch.",
  },
  "git.createBranch": {
    code: "CONFLICT",
    message: "Unable to create git branch.",
  },
  "git.diff": {
    code: "FORBIDDEN",
    message: "<home> is outside the checkout",
  },
  "git.discard": {
    code: "NOT_FOUND",
    message: "No workspace fixture",
  },
  "git.checkoutStatus": {
    code: "NOT_FOUND",
    message: "No workspace fixture",
  },
  "git.watch": {
    code: "NOT_FOUND",
    message: "No workspace fixture",
  },
  "files.rename": {
    code: "CONFLICT",
    message: "Path outside workspace",
  },
  "files.trash": {
    code: "CONFLICT",
    message: "Path outside workspace",
  },
  "files.readImageAsDataUrl": {
    code: "CONFLICT",
    message: "unsupported-extension",
  },
  "files.readText": {
    code: "CONFLICT",
    message: "not-a-file",
  },
  "files.readPptx": {
    code: "CONFLICT",
    message: "not-a-file",
  },
  "ai.subscribe": {
    code: "NOT_FOUND",
    message: "No session fixture",
  },
  "ai.runFinished": {
    code: "20",
    message: "This operation was aborted",
  },
  "ai.send": {
    code: "NOT_FOUND",
    message: "No session fixture",
  },
  "ai.hydrate": {
    code: "NOT_FOUND",
    message: "No session fixture",
  },
  "ai.react": {
    code: "NOT_FOUND",
    message: "No session fixture",
  },
  "ai.respondPermission": {
    code: "UNAVAILABLE",
    message: "The agent is not running",
  },
  "ai.queue.enqueue": {
    code: "UNAVAILABLE",
    message: "The agent is not running",
  },
  "ai.queue.update": {
    code: "UNAVAILABLE",
    message: "The agent is not running",
  },
  "ai.queue.remove": {
    code: "UNAVAILABLE",
    message: "The agent is not running",
  },
  "ai.queue.clear": {
    code: "UNAVAILABLE",
    message: "The agent is not running",
  },
  "ai.queue.dequeue": {
    code: "UNAVAILABLE",
    message: "The agent is not running",
  },
  "bots.openChat": {
    code: "NOT_FOUND",
    message: "No bot fixture",
  },
  "bots.events": {
    code: "20",
    message: "This operation was aborted",
  },
  "routines.editByChat": {
    code: "NOT_FOUND",
    message: "No routine fixture",
  },
  "routines.events": {
    code: "20",
    message: "This operation was aborted",
  },
  "settings.events": {
    code: "20",
    message: "This operation was aborted",
  },
  "auth.web.complete": {
    code: "UNAUTHORIZED",
    message: "Unauthorized",
  },
  "mcp.runtime.events": {
    code: "20",
    message: "This operation was aborted",
  },
  "terminal.output": {
    code: "NOT_FOUND",
    message: "No terminal terminal-1",
  },
  "voice.whisper.progress": {
    code: "20",
    message: "This operation was aborted",
  },
  "messaging.events": {
    code: "20",
    message: "This operation was aborted",
  },
  "system.events": {
    code: "20",
    message: "This operation was aborted",
  },
  "db.sessions.update": {
    code: "NOT_FOUND",
    message: "No session fixture",
  },
  "db.sessions.delete": {
    code: "NOT_FOUND",
    message: "No session fixture",
  },
  "db.bots.update": {
    code: "NOT_FOUND",
    message: "No bot fixture",
  },
  "db.bots.delete": {
    code: "NOT_FOUND",
    message: "No bot fixture",
  },
  "db.routines.update": {
    code: "NOT_FOUND",
    message: "No routine fixture",
  },
  "db.routines.delete": {
    code: "NOT_FOUND",
    message: "No routine fixture",
  },
  "db.memories.delete": {
    code: "BAD_REQUEST",
    message: "A global memory names its target",
  },
  "db.workspaces.update": {
    code: "NOT_FOUND",
    message: "No workspace fixture",
  },
  "db.workspaces.delete": {
    code: "NOT_FOUND",
    message: "No workspace fixture",
  },
};

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
  const unhandled = (error: unknown) =>
    failures.push(`background rejection: ${String(error)}`);
  process.on("unhandledRejection", unhandled);
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
      const timer = setTimeout(
        () => abort.abort(),
        expectedFailures[name]?.code === "20" ? 1000 : 30_000
      );
      try {
        const listeners = host.deps.bus.listenerCount();
        const value = await client(input, { signal: abort.signal });
        if (value && typeof value.next === "function") {
          try {
            const first = value.next();
            if (name === "files.events") {
              await vi.waitFor(() =>
                expect(host.deps.bus.listenerCount()).toBeGreaterThan(listeners)
              );
              host.deps.bus.dispatch({
                type: "file-tree-root-updated",
                emittedAt: new Date().toISOString(),
              });
              await expect(first).resolves.toMatchObject({
                value: { type: "tree-root-changed" },
              });
            } else await first;
          } finally {
            abort.abort();
            await value.return?.();
          }
        }
        if (expectedFailures[name])
          failures.push(
            `${name}: expected ${expectedFailures[name].code}, call succeeded`
          );
      } catch (error) {
        const expected = expectedFailures[name];
        const code = String((error as { code?: unknown }).code);
        const message = String((error as Error).message).replaceAll(
          fixture.home,
          "<home>"
        );
        if (!expected || expected.code !== code || expected.message !== message)
          failures.push(`${name}: ${code} ${message}`);
      } finally {
        clearTimeout(timer);
      }
    }
    expect(called).toBe(retained.length);
    expect(called).toBeGreaterThan(150);
    console.info(`Retained procedures exercised: ${called}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fixture.unsupported).toEqual([]);
    expect(failures).toEqual([]);
  } finally {
    transport.closeClient();
    transport.closeServer();
    await host.dispose();
    process.off("unhandledRejection", unhandled);
    vi.unstubAllGlobals();
  }
}, 180_000);
afterAll(() => rmSync(fixture.home, { recursive: true, force: true }));
