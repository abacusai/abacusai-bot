/**
 * Which files a turn hands over.
 *
 * The agent's own declaration wins; otherwise the turn's file-writing calls
 * are read, filtered to the kinds of file a person asks for. The filter is
 * the claim worth pinning: a code turn must not grow a files card.
 */
import { describe, expect, it } from "vitest";

import { turnDeliverables } from "./deliverables";
import type { AgentRenderItem, ToolRenderItem } from "./render-utils";

const tool = (
  name: string,
  input: Record<string, unknown>,
  overrides: Partial<ToolRenderItem> = {}
): ToolRenderItem => ({
  id: `${name}-${JSON.stringify(input)}`,
  name,
  input,
  result: { id: "r", content: "" },
  state: "done",
  streamingArgs: false,
  ...overrides,
});

const turn = (...tools: ToolRenderItem[]): AgentRenderItem[] => [
  { kind: "text", id: "t1", content: "On it.", streaming: false },
  { kind: "tool_group", id: "g1", tools, summary: "", state: "done" },
  { kind: "text", id: "t2", content: "Done.", streaming: false },
];

describe("a declared handover", () => {
  it("is the list, in the agent's order, with its labels", () => {
    const items = turnDeliverables(
      turn(
        tool("write", { file_path: "/w/scratch.pdf" }),
        tool("agent-tools_present_deliverable", {
          items: [
            { path: "/w/report.docx", label: "Q3 report" },
            { path: "http://localhost:5173" },
          ],
        })
      )
    );

    expect(items).toEqual([
      { path: "/w/report.docx", label: "Q3 report", isUrl: false },
      { path: "http://localhost:5173", isUrl: true },
    ]);
  });

  it("shows what the tool accepted, not everything the model listed", () => {
    // The tool checks the disk and declares each item it kept. A path the
    // model made up is named in prose only, and must not become a row.
    const items = turnDeliverables(
      turn(
        tool(
          "agent-tools_present_deliverable",
          {
            items: [
              { path: "/w/report.md", label: "Morning Brief" },
              { path: "/w/a@b.com_c@d.com", label: "placeholder" },
            ],
          },
          {
            result: {
              id: "r",
              content:
                "- [Morning Brief](file:///w/report.md)\n\n" +
                "Not presented, because there is no file at these paths: /w/a@b.com_c@d.com\n\n" +
                "[artifact] /w/report.md",
            },
          }
        )
      )
    );

    expect(items).toEqual([
      { path: "/w/report.md", label: "Morning Brief", isUrl: false },
    ]);
  });

  it("counts for nothing when it was rejected or is still running", () => {
    const rejected = tool(
      "present_deliverable",
      { items: [{ path: "/w/a.pdf" }] },
      { result: { id: "r", content: "", rejected: true } }
    );
    const running = tool(
      "present_deliverable",
      { items: [{ path: "/w/b.pdf" }] },
      { state: "running" }
    );

    expect(turnDeliverables(turn(rejected, running))).toEqual([]);
  });
});

describe("a turn that wrote files and never said which", () => {
  it("shows the documents and not the code", () => {
    const items = turnDeliverables(
      turn(
        tool("write", { file_path: "src/app.ts" }),
        tool("edit", { file_path: "/w/README.md" }),
        tool("write", { file_path: "/w/out/summary.docx" }),
        tool("write", { file_path: "/w/todo.md" })
      )
    );

    expect(items.map((item) => item.path)).toEqual([
      "/w/README.md",
      "/w/out/summary.docx",
    ]);
  });

  it("knows what the component tools built", () => {
    const items = turnDeliverables(
      turn(
        tool("agent-tools_ppt", { output_path: "/w/deck.html" }),
        tool("agent-tools_design", { output_dir: "/w/brand" }),
        tool(
          "agent-tools_image_generate",
          { prompt: "a cat" },
          {
            result: { id: "r", content: "Saved.\n[artifact] /media/cat.png" },
          }
        )
      )
    );

    expect(items.map((item) => item.path)).toEqual([
      "/w/deck.pdf",
      "/w/brand/canvas.html",
      "/media/cat.png",
    ]);
  });

  it("lists a path once however many times it was written", () => {
    const items = turnDeliverables(
      turn(
        tool("write", { file_path: "/w/report.md" }),
        tool("edit", { file_path: "/w/report.md" })
      )
    );

    expect(items).toHaveLength(1);
  });
});
