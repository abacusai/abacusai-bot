/**
 * What the component tools report when the user presses Stop.
 *
 * Each of these keys "completed" off a file existing, and a stopped run can
 * easily have written one — the deck is printed several turns before the
 * sub-agent is finished with it. Reporting that as a success puts a green
 * checkmark on the card and tells the model to hand the fragment over as the
 * finished deliverable.
 *
 * The sub-agent runs themselves are stubbed: what is under test is the
 * translation from a run's outcome to what the parent and the model are told,
 * not the runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "./protocol.js";

const stubs = vi.hoisted(() => ({
  deck: vi.fn(),
  design: vi.fn(),
  document: vi.fn(),
}));

vi.mock("./deck-task.js", () => ({ runDeckTask: stubs.deck }));
vi.mock("./design-task.js", () => ({ runDesignTask: stubs.design }));
vi.mock("./document-task.js", () => ({ runDocumentTask: stubs.document }));

const { buildDeckTool } = await import("./deck-tool.js");
const { buildDesignTool } = await import("./design-tool.js");
const { buildDocumentTool } = await import("./document-tool.js");

const context = { cwd: process.cwd() } as never;

interface Case {
  name: string;
  build: (
    context: never,
    emit: (event: AgentEvent) => void
  ) => {
    execute: (
      id: string,
      params: Record<string, unknown>,
      signal?: AbortSignal
    ) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  };
  stub: (typeof stubs)["deck"];
  params: Record<string, unknown>;
  /** What the run produced before it was stopped. */
  produced: Record<string, unknown>;
}

const CASES: Case[] = [
  {
    name: "ppt",
    build: buildDeckTool as never,
    stub: stubs.deck,
    params: { brief: "a deck", output_path: "out.pdf" },
    produced: { pdfPath: "/tmp/out.pdf", slides: 5, template: "pitch" },
  },
  {
    name: "design",
    build: buildDesignTool as never,
    stub: stubs.design,
    params: { brief: "a design", output_dir: "out" },
    produced: { canvasPath: "/tmp/out/canvas.html", screens: 3 },
  },
  {
    name: "document",
    build: buildDocumentTool as never,
    stub: stubs.document,
    params: { brief: "a document", output_path: "out.pdf" },
    produced: { pdfPath: "/tmp/out.pdf" },
  },
];

beforeEach(() => {
  for (const stub of Object.values(stubs)) stub.mockReset();
});

describe.each(CASES)("$name, stopped after it produced a file", (subject) => {
  const run = async (
    stoppedBy: string
  ): Promise<{
    events: AgentEvent[];
    result: { isError?: boolean; content: Array<{ text: string }> };
  }> => {
    subject.stub.mockResolvedValue({
      ...subject.produced,
      text: "partial work",
      turns: 4,
      stoppedBy,
    });

    const events: AgentEvent[] = [];
    const tool = subject.build(context, (event) => events.push(event));
    const result = await tool.execute("call-1", subject.params);

    return { events, result };
  };

  const endStatus = (events: AgentEvent[]): unknown =>
    events.find((event) => event.type === "subtask_end")?.status;

  it("closes the card as failed rather than completed", async () => {
    const { events } = await run("aborted");

    expect(endStatus(events)).toBe("failed");
  });

  it("tells the model the work was stopped, not delivered", async () => {
    const { result } = await run("aborted");

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/stopped/i);
    // The green path ends by naming the next step; a stopped run must not.
    expect(result.content[0]?.text).not.toMatch(/present_deliverable/);
  });

  it("still reports a finished run as completed", async () => {
    const { events, result } = await run("done");

    expect(endStatus(events)).toBe("completed");
    expect(result.isError).toBeUndefined();
  });
});
