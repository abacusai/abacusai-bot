import { describe, expect, it, vi } from "vitest";

import type { HostServiceClient } from "./host-services.js";
import {
  buildMotionTools,
  RENDER_TIMEOUT_MS,
  runMotionTask,
} from "./motion-task.js";
import { buildMotionTool } from "./motion-tool.js";

vi.mock("./motion-task.js", async (actual) => ({
  ...(await actual<typeof import("./motion-task.js")>()),
  runMotionTask: vi.fn(),
}));

const host = (
  answer: (service: string, payload: unknown) => unknown
): { client: HostServiceClient; calls: Array<[string, unknown, unknown]> } => {
  const calls: Array<[string, unknown, unknown]> = [];
  return {
    calls,
    client: {
      request: async (service: string, payload: unknown, timeout?: number) => {
        calls.push([service, payload, timeout]);
        return answer(service, payload);
      },
    } as unknown as HostServiceClient,
  };
};

const tool = (tools: ReturnType<typeof buildMotionTools>, name: string) =>
  tools.find((entry) => entry.name === name)!;

describe("the motion sub-agent's tools", () => {
  it("renders into the tool's directory, with a long timeout, and records the video", async () => {
    const done = { current: null as never };
    const { client, calls } = host(() => ({
      videoPath: "/ws/out/hook.mp4",
      size: "9:16",
      seconds: 8.7,
      width: 1080,
      height: 1920,
      template: "kinetic-text",
      warnings: ['Ignored "colour": kinetic-text has no such slot.'],
    }));
    const tools = buildMotionTools(done, "/ws/out", client, "/ws");

    const result = await tool(tools, "render_motion").execute("1", {
      plan: {
        template: "kinetic-text",
        size: "9:16",
        slots: { lines: ["a", "b"] },
        // The sub-agent cannot pick where the file goes.
        outputDir: "/etc",
      },
    });

    expect(result.isError).toBeUndefined();
    expect(calls[0]![0]).toBe("render_motion");
    // A relative image path (an attached logo) is the workspace's.
    expect(calls[0]![1]).toMatchObject({ outputDir: "/ws/out", cwd: "/ws" });
    expect(calls[0]![2]).toBe(RENDER_TIMEOUT_MS);
    expect(result.content[0]!.text).toMatch(/8\.7 s at 1080×1920 \(9:16\)/);
    expect(result.content[0]!.text).toContain("Ignored");
    expect(done.current).toMatchObject({
      videoPath: "/ws/out/hook.mp4",
      size: "9:16",
    });
  });

  it("stops at a failure no other plan fixes, and says so", async () => {
    const done = { current: null, failed: null as string | null };
    const { client } = host(() => {
      throw new Error(
        "This computer could not render the video: the video encoder did not load (x). A different plan will not fix this."
      );
    });
    const result = await tool(
      buildMotionTools(done, "/ws/out", client),
      "render_motion"
    ).execute("1", { plan: { template: "title-card" } });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Do not call render_motion again/);
    expect(done.failed).toMatch(/encoder did not load/);
  });
});

describe("the motion tool", () => {
  const motion = buildMotionTool(
    {
      cwd: "/ws",
      agentDir: "/agent",
      hostServices: host(() => ({})).client,
      skillPaths: [],
    } as never,
    () => {}
  );

  it("tells the agent not to try again when the computer cannot render", async () => {
    vi.mocked(runMotionTask).mockResolvedValueOnce({
      text: "No video.",
      turns: 3,
      stoppedBy: "completed",
      failed:
        "This computer could not render the video: the video encoder did not load (x). A different plan will not fix this.",
    });
    const result = await motion.execute("1", {
      brief: "an intro",
      output_dir: "out",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/encoder did not load/);
    expect(result.content[0]!.text).toMatch(/Do not call motion again/);
  });
});
