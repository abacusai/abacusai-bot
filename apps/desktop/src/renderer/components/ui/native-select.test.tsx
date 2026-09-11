import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";

import { NativeSelect, NativeSelectOption } from "./native-select";

describe("NativeSelect", () => {
  it("keeps the accessible native control and automation id", () => {
    render(
      <label>
        Workspace
        <NativeSelect data-id="workspace-select">
          <NativeSelectOption value="main">Main</NativeSelectOption>
        </NativeSelect>
      </label>
    );

    const select = screen.getByRole("combobox", { name: "Workspace" });
    expect(select.getAttribute("data-id")).toBe("workspace-select");
    expect(select.getAttribute("data-size")).toBe("default");
    expect(select.parentElement?.getAttribute("data-slot")).toBe(
      "native-select-wrapper"
    );
  });

  it("forwards refs to the select element", () => {
    const ref = createRef<HTMLSelectElement>();

    render(
      <NativeSelect ref={ref} aria-label="Runtime">
        <option value="local">Local</option>
      </NativeSelect>
    );

    expect(ref.current).toBe(screen.getByRole("combobox", { name: "Runtime" }));
  });
});
