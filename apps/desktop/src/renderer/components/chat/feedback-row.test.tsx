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

describe("the thumbs", () => {
  it("are not offered when the turn cannot be rated", () => {
    render(<FeedbackRow content="Answer" creditsTotal={0} />);

    expect(
      screen.queryByRole("button", { name: /feedback\.helpful/i })
    ).toBeNull();
  });

  it("report the verdict, and a second click withdraws it", async () => {
    const onRate = vi.fn(async () => true);
    render(<FeedbackRow content="Answer" creditsTotal={0} onRate={onRate} />);

    const up = screen.getByRole("button", { name: /feedback\.helpful/i });
    fireEvent.click(up);
    await waitFor(() => expect(onRate).toHaveBeenCalledWith("up"));
    await waitFor(() => expect(up.getAttribute("aria-pressed")).toBe("true"));

    fireEvent.click(up);
    await waitFor(() => expect(onRate).toHaveBeenCalledWith("clear"));
    await waitFor(() => expect(up.getAttribute("aria-pressed")).toBe("false"));
  });

  it("reverts the thumb when the report fails", async () => {
    const onRate = vi.fn(async () => false);
    render(<FeedbackRow content="Answer" creditsTotal={0} onRate={onRate} />);

    const down = screen.getByRole("button", { name: /feedback\.notHelpful/i });
    fireEvent.click(down);
    await waitFor(() => expect(onRate).toHaveBeenCalledWith("down"));
    await waitFor(() =>
      expect(down.getAttribute("aria-pressed")).toBe("false")
    );
  });
});

describe("tell us more", () => {
  it("opens on a thumbs-down and sends the comment as a follow-up", async () => {
    const onRate = vi.fn(async () => true);
    render(<FeedbackRow content="Answer" creditsTotal={0} onRate={onRate} />);

    fireEvent.click(
      screen.getByRole("button", { name: /feedback\.notHelpful/i })
    );
    await waitFor(() => expect(onRate).toHaveBeenCalledWith("down"));

    const box = await screen.findByPlaceholderText(/tellUsMorePlaceholder/i);
    fireEvent.change(box, { target: { value: "  it made up a file  " } });
    fireEvent.click(screen.getByRole("button", { name: /feedback\.send/i }));

    await waitFor(() =>
      expect(onRate).toHaveBeenLastCalledWith("down", "it made up a file")
    );
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/tellUsMorePlaceholder/i)).toBeNull()
    );
  });

  it("can be skipped, keeping the thumbs-down", async () => {
    const onRate = vi.fn(async () => true);
    render(<FeedbackRow content="Answer" creditsTotal={0} onRate={onRate} />);

    const down = screen.getByRole("button", { name: /feedback\.notHelpful/i });
    fireEvent.click(down);
    await screen.findByPlaceholderText(/tellUsMorePlaceholder/i);
    fireEvent.click(screen.getByRole("button", { name: /feedback\.skip/i }));

    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/tellUsMorePlaceholder/i)).toBeNull()
    );
    expect(onRate).toHaveBeenCalledTimes(1);
    expect(down.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not open on a thumbs-up", async () => {
    const onRate = vi.fn(async () => true);
    render(<FeedbackRow content="Answer" creditsTotal={0} onRate={onRate} />);

    fireEvent.click(screen.getByRole("button", { name: /feedback\.helpful/i }));
    await waitFor(() => expect(onRate).toHaveBeenCalledWith("up"));
    expect(screen.queryByPlaceholderText(/tellUsMorePlaceholder/i)).toBeNull();
  });
});
