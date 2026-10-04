import { ORPCError, call } from "@orpc/server";
import { expect, it } from "vitest";

import { createRouter } from "../rpc/router";
import { fakeDeps } from "../rpc/testing";
import { supportsProcedure, WEB_HOST_DENIED } from "./capabilities";
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
  expect(supportsProcedure("web-host", "update.status")).toBe(true);
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
