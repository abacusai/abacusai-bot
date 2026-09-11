import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FeedbackRow } from "./feedback-row";

describe("FeedbackRow", () => {
  const writeText = vi.fn(async () => undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("reserves the copy action layout while revealing it on hover or focus", () => {
    const { container } = render(
      <div className="group/assistant">
        <FeedbackRow content="Answer" creditsTotal={0} />
      </div>
    );

    const button = screen.getByRole("button", { name: /copy/i });
    const action = container.querySelector(
      "[data-id='local-code-feedback-actions']"
    );
    expect(button.getAttribute("aria-label")).toMatch(/copy/i);
    expect(action).toBeTruthy();
    expect(action?.className).toContain("opacity-0");
    expect(action?.className).toContain("group-hover/assistant:opacity-100");
    expect(action?.className).toContain(
      "group-focus-within/assistant:opacity-100"
    );
    expect(
      container.querySelector("[data-id='local-code-feedback-row']")
    ).toBeTruthy();
  });

  it("copies the settled assistant response", async () => {
    render(<FeedbackRow content="Complete answer" creditsTotal={0} />);

    fireEvent.click(screen.getByRole("button", { name: /copy/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("Complete answer");
    });
  });
});
