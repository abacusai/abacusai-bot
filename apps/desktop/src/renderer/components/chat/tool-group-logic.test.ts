import { describe, expect, it } from "vitest";

import type { ToolRenderItem } from "./render-utils";
import {
  summarizeToolGroup,
  toolGroupAction,
  toolGroupState,
  toolGroupSummaryKind,
} from "./tool-group-logic";

function tool(
  name: string,
  state: ToolRenderItem["state"] = "done",
  input: Record<string, unknown> = {}
): ToolRenderItem {
  return {
    id: `${name}-${JSON.stringify(input)}`,
    name,
    input,
    state,
    streamingArgs: false,
  };
}

describe("T3-style tool group derivation", () => {
  it("classifies provider tool names into the shared action vocabulary", () => {
    expect(toolGroupAction(tool("read"))).toBe("read");
    expect(toolGroupAction(tool("apply_patch"))).toBe("edit");
    expect(toolGroupAction(tool("exec_command"))).toBe("command");
    expect(toolGroupAction(tool("grep"))).toBe("code-search");
    expect(toolGroupAction(tool("web_search"))).toBe("search");
    expect(toolGroupAction(tool("custom_mcp_tool"))).toBe("other");
  });

  it("counts distinct edited files rather than raw edit calls", () => {
    expect(
      summarizeToolGroup([
        tool("edit", "done", { file_path: "src/app.tsx" }),
        tool("apply_patch", "done", { path: "src/app.tsx" }),
        tool("write", "done", { file_path: "src/new.ts" }),
      ])
    ).toBe("Changed 2 files");
  });

  it("summarizes mixed settled work in chronological action order", () => {
    expect(summarizeToolGroup([tool("read"), tool("bash"), tool("grep")])).toBe(
      "Read 1 file, ran 1 command, and searched code 1 time"
    );
    expect(toolGroupSummaryKind([tool("read"), tool("bash")])).toBe("mixed");
  });

  it("uses running language while any call remains active", () => {
    const tools = [tool("bash"), tool("bash", "running")];
    expect(toolGroupState(tools)).toBe("running");
    expect(summarizeToolGroup(tools)).toBe("Running 2 commands");
  });

  it("keeps errors terminal when no call remains active", () => {
    expect(toolGroupState([tool("read"), tool("bash", "error")])).toBe("error");
  });
});
