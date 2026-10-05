import { contract } from "@abacus-ai/contract/contract";
import { ORPCError, call } from "@orpc/server";
import { expect, it } from "vitest";

import { createRouter } from "../rpc/router";
import { fakeDeps } from "../rpc/testing";
import {
  supportsProcedure,
  WEB_HOST_DENIED,
  WEB_HOST_ALLOWED,
} from "./capabilities";
it("Electron denies nothing and web-host refuses the complete capability table", () => {
  for (const path of WEB_HOST_DENIED) {
    expect(supportsProcedure("electron", path)).toBe(true);
    expect(supportsProcedure("web-host", path)).toBe(false);
  }
  expect(supportsProcedure("web-host", "mcp.import", { source: "file" })).toBe(
    false
  );
  expect(supportsProcedure("web-host", "mcp.import", { source: "json" })).toBe(
    true
  );
  expect(supportsProcedure("web-host", "update.status")).toBe(false);
});
it("the router guard returns a defined UNSUPPORTED before a window guard or service runs", async () => {
  const context = {
    transport: "memory" as const,
    platform: "web-host" as const,
    webContentsId: null,
    windowKind: "dev" as const,
    deps: fakeDeps(),
  };
  await expect(
    call(
      createRouter().window.state,
      {},
      { context, path: ["window", "state"] }
    )
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
    status: 501,
    data: { procedure: "window.state" },
  });
  await expect(
    call(
      createRouter().mcp.import,
      { mode: "code", source: "file" },
      { context, path: ["mcp", "import"] }
    )
  ).rejects.toBeInstanceOf(ORPCError);
});

it("every contract procedure is explicitly classified; unknown procedures fail closed", () => {
  const walk = (node: object, path: string[] = []): string[] =>
    "~orpc" in node
      ? [path.join(".")]
      : Object.entries(node).flatMap(([key, value]) =>
          walk(value, [...path, key])
        );
  const paths = walk(contract);
  for (const path of paths) {
    const denied = WEB_HOST_DENIED.some(
      (prefix) => path === prefix || path.startsWith(prefix + ".")
    );
    const allowed = WEB_HOST_ALLOWED.some((value) => value === path);
    expect(Number(denied) + Number(allowed), path).toBe(1);
  }
  for (const path of WEB_HOST_ALLOWED) expect(paths).toContain(path);
  expect(supportsProcedure("web-host", "future.procedure")).toBe(false);
});
