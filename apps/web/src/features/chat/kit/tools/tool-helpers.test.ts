import { describe, expect, it } from "vitest";

import { resolveWorkspacePath } from "#renderer/components/file-preview/paths";

import { parseImageRead } from "./image-read";
import { humanToolName, stripLineNumbers, todoItems } from "./normalize";
import { browserInputLines, expanderFor } from "./tool-line";
import { toolMeta, toolOpenPath } from "./tool-meta";

describe("tool helpers", () => {
  it("strips arrow line-number prefixes only when every line has one", () => {
    expect(stripLineNumbers("   12→a\n   13→b")).toEqual({
      text: "a\nb",
      startLine: 12,
    });
    expect(stripLineNumbers("1→a\nplain").text).toBe("1→a\nplain");
  });

  it("reads checklist items with defaulted status", () => {
    expect(
      todoItems({
        todos: [{ content: " a ", status: "completed" }, { content: "b" }, 3],
      })
    ).toEqual([
      { content: "a", status: "completed" },
      { content: "b", status: "pending" },
    ]);
  });

  it("names MCP tools without their prefix", () => {
    expect(humanToolName("mcp__linear__create_issue")).toBe("Create Issue");
    expect(humanToolName("agent-tools_web_fetch")).toBe("Web Fetch");
  });

  it("resolves relative paths against the workspace", () => {
    expect(resolveWorkspacePath("src/a.ts", "/ws/")).toBe("/ws/src/a.ts");
    expect(resolveWorkspacePath("/abs/a.ts", "/ws")).toBe("/abs/a.ts");
    expect(resolveWorkspacePath("\\\\srv\\share\\a.ts", "/ws")).toBe(
      "\\\\srv\\share\\a.ts"
    );
    expect(toolOpenPath("edit", { file_path: "./a.ts" }, "/ws")).toBe(
      "/ws/a.ts"
    );
    expect(toolOpenPath("bash", { path: "x" }, "/ws")).toBeNull();
  });

  it("opens a file chip for batch_edit, delete and apply_patch", () => {
    for (const name of ["batch_edit", "delete", "apply_patch"])
      expect(toolOpenPath(name, { path: "a.ts" }, "/w")).toBe("/w/a.ts");
  });

  it("hides the body of present_deliverable", () => {
    expect(expanderFor("present_deliverable")).toBe("none");
    expect(expanderFor("agent-tools_present_deliverable")).toBe("none");
    expect(expanderFor("web_search")).toBe("generic");
  });

  it("recognises an image read envelope only", () => {
    const envelope = JSON.stringify({
      type: "read",
      status: "success",
      mimeType: "image/png",
      filePath: "/w/a.png",
      filename: "a.png",
      size: 2048,
    });
    expect(parseImageRead(envelope)).toEqual({
      filePath: "/w/a.png",
      filename: "a.png",
      size: 2048,
      mimeType: "image/png",
    });
    expect(parseImageRead(envelope.replace("image/png", "text/plain"))).toBe(
      null
    );
    expect(parseImageRead("plain text")).toBe(null);
  });

  it("lists a browser call's own arguments", () => {
    expect(
      browserInputLines("browser_interact", {
        action: "type",
        ref: "e5",
        selector: "#x",
        text: "hello",
        key: "Enter",
      })
    ).toEqual([
      ["Action", "type"],
      ["Ref", "e5"],
      ["Text", "hello"],
      ["Key", "Enter"],
    ]);
    expect(
      browserInputLines("browser_snapshot", { selector: "main", depth: 3 })
    ).toEqual([
      ["Scope", "main"],
      ["Depth", "3"],
    ]);
    expect(
      browserInputLines("browser_execute", { code: "x".repeat(300) })[0]![1]
    ).toHaveLength(201);
  });

  it("a running command's meta says how far it has got and since when it has been quiet", () => {
    const running = (output: string) =>
      ({
        status: "running",
        text: "",
        terminal: { output },
        source: "live",
      }) as Parameters<typeof toolMeta>[2];
    expect(toolMeta("bash", {}, running(" 10%\r 64%"), 1_000, 9_000)).toEqual({
      kind: "elapsed",
      since: 1_000,
      progress: 64,
      quietSince: 9_000,
    });
    // Nothing printed yet: quiet since it started.
    expect(toolMeta("bash", {}, running(""), 1_000, null)).toMatchObject({
      progress: null,
      quietSince: 1_000,
    });
  });
});
