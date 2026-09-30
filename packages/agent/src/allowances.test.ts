import { describe, expect, it } from "vitest";

import { Allowances } from "./allowances.js";
import type { PermissionRequest, ToolRequest } from "./protocol.js";

const tool = (name: string, input: Record<string, unknown> = {}): ToolRequest =>
  ({ id: "t1", name, input }) as ToolRequest;

const asks = (type: string, extra: Record<string, unknown> = {}) =>
  ({ type, ...extra }) as unknown as PermissionRequest;

describe("what Always allow widens", () => {
  it("a read outside the workspace: that directory, not every read", () => {
    const allowances = new Allowances();
    allowances.remember(
      tool("read", { path: "/Users/me/Documents/x.txt" }),
      asks("read_outside_directory", {
        deducedDirectory: "/Users/me/Documents",
      })
    );

    expect(allowances.readPaths).toEqual(["/Users/me/Documents"]);
    expect(allowances.tools.has("read")).toBe(false);
    expect(allowances.gateOptions().allowedReadPaths).toEqual([
      "/Users/me/Documents",
    ]);
  });

  it("a write or edit outside the workspace: that directory, for writes", () => {
    const allowances = new Allowances();
    allowances.remember(
      tool("edit", { file_path: "/tmp/out/a" }),
      asks("edit_outside_directory", { deducedDirectory: "/tmp/out" })
    );

    expect(allowances.writePaths).toEqual(["/tmp/out"]);
    expect(allowances.readPaths).toEqual([]);
  });

  it("a fetch: its origin", () => {
    const allowances = new Allowances();
    allowances.remember(
      tool("web_fetch", { url: "https://docs.example.com/a/b?c" }),
      asks("web_fetch")
    );
    allowances.remember(
      tool("web_fetch", { url: "not a url" }),
      asks("web_fetch")
    );

    expect(allowances.origins).toEqual(["https://docs.example.com"]);
    expect(allowances.tools.has("web_fetch")).toBe(false);
  });

  it("a shell call: the first word of each segment, past VAR=val", () => {
    const allowances = new Allowances();
    allowances.remember(
      tool("bash", { command: "FOO=1 npm test && cd repo; git pull" }),
      asks("bash")
    );

    expect(allowances.commands).toEqual(["npm", "cd", "git"]);
  });

  it("any other tool: the tool as a whole, once", () => {
    const allowances = new Allowances();
    allowances.remember(tool("image_view"), asks("tool"));
    allowances.remember(tool("image_view"), asks("tool"));

    expect([...allowances.tools]).toEqual(["image_view"]);
  });

  it("lays the host's own lists under the user's", () => {
    const allowances = new Allowances({
      readPaths: ["/seed/read"],
      writePaths: ["/seed/write"],
    });
    allowances.allowCommandRules(["make *"]);

    expect(
      allowances.gateOptions({
        commands: ["ls"],
        tools: ["react"],
        readPaths: ["/config/read"],
      })
    ).toEqual({
      allowedCommands: ["ls", "make *"],
      allowedTools: ["react"],
      allowedReadPaths: ["/config/read", "/seed/read"],
      allowedWritePaths: ["/seed/write"],
      allowedOrigins: [],
    });
  });
});
