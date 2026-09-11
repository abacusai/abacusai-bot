import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FileMentionPicker } from "./file-mention-picker";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const results = [
  {
    relativePath: "src/components/button.tsx",
    fileName: "button.tsx",
    kind: "file" as const,
  },
  {
    relativePath: "src/components",
    fileName: "components",
    kind: "directory" as const,
  },
];

describe("FileMentionPicker", () => {
  it("composes accessible options and selects without taking input focus", () => {
    const onSelect = vi.fn();
    render(
      <FileMentionPicker
        results={results}
        selectedIndex={1}
        onSelect={onSelect}
        visible
        query="comp"
        isLoading={false}
        isError={false}
      />
    );

    expect(screen.getByRole("listbox").getAttribute("id")).toBe(
      "file-mention-picker"
    );
    expect(screen.getByText("@comp")).toBeDefined();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");

    fireEvent.mouseDown(options[0]);
    expect(onSelect).toHaveBeenCalledWith(results[0]);
  });

  it("keeps the popup useful while loading and when no file matches", () => {
    const { rerender } = render(
      <FileMentionPicker
        results={[]}
        selectedIndex={0}
        onSelect={() => {}}
        visible
        query="missing"
        isLoading
        isError={false}
      />
    );

    expect(screen.getByRole("listbox")).toBeDefined();
    expect(screen.queryByText("workspace.explorer.noFiles")).toBeNull();

    rerender(
      <FileMentionPicker
        results={[]}
        selectedIndex={0}
        onSelect={() => {}}
        visible
        query="missing"
        isLoading={false}
        isError={false}
      />
    );
    expect(screen.getByText("workspace.explorer.noFiles")).toBeDefined();
  });
});
