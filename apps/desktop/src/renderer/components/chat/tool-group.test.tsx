import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ToolRenderItem } from "./render-utils";
import { ToolGroupBlock } from "./tool-group";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../providers/preview-link-context", () => ({
  usePreviewLinkHandler: () => vi.fn(),
}));

vi.mock("../../hooks/use-workspace-root", () => ({
  useResolveWorkspacePath: () => (path: string) => path,
  useWorkspaceRoot: () => "/workspace",
}));

const command: ToolRenderItem = {
  id: "command-1",
  name: "bash",
  input: { command: "pnpm test" },
  result: { id: "result-1", content: "tests passed" },
  state: "done",
  streamingArgs: false,
};

describe("ToolGroupBlock", () => {
  it("renders a compact collapsed row and reveals details on demand", () => {
    render(
      <ToolGroupBlock
        id="group-1"
        tools={[command]}
        summary="Ran 1 command"
        state="done"
      />
    );

    const trigger = screen.getByRole("button", { name: /Ran 1 command/u });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("pnpm test")).toBeNull();

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("pnpm test")).not.toBeNull();
  });

  it("shows a failed group like any other, without raw arguments in the summary", () => {
    render(
      <ToolGroupBlock
        id="group-2"
        tools={[{ ...command, state: "error" }]}
        summary="Ran 1 command"
        state="error"
      />
    );

    // The failure is the agent's to route around, and it usually does on the
    // next line — a red row on every probe that came back empty read as the
    // chat going wrong.
    expect(
      screen
        .getByRole("button", { name: /Ran 1 command/u })
        .getAttribute("aria-invalid")
    ).toBeNull();
    expect(screen.queryByText("pnpm test")).toBeNull();
  });
});
