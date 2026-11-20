import type { UIMessage } from "@tanstack/ai-client";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Decorate } from "#renderer/components/run-report";
import { i18n, initI18n } from "#renderer/lib/i18n";

import { messageText, withWebsitePrompt } from "./website-prompt-label";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en-US");
});

const message = (id: string, role: UIMessage["role"], text: string) =>
  ({ id, role, parts: [{ type: "text", content: text }] }) as UIMessage;

const MESSAGES = [
  message("u1", "user", "Build a booking site"),
  message("a1", "assistant", "On it."),
  message("u2", "user", "Make it blue"),
];

const decorateAll = (decorate: Decorate, runActive: boolean) =>
  MESSAGES.map((row, index) =>
    decorate(row, { messages: MESSAGES, index, runActive })
  );

describe("withWebsitePrompt", () => {
  it("leaves every message alone outside the website's chat", () => {
    const inner: Decorate = () => null;
    expect(withWebsitePrompt(inner, null)).toBe(inner);
  });

  it("labels only the person's first message, keeping what was already there", () => {
    const inner: Decorate = (row) =>
      row.id === "u1" ? { before: <i data-testid="kept" /> } : null;
    const decorated = decorateAll(
      withWebsitePrompt(inner, { stop: vi.fn(), edit: vi.fn() }),
      false
    );
    expect(decorated.map((d) => d?.before != null)).toEqual([
      true,
      false,
      false,
    ]);
    render(<>{decorated[0]!.before}</>);
    expect(screen.getByTestId("kept")).toBeTruthy();
    expect(screen.getByText("Your task from the website")).toBeTruthy();
  });

  it("offers Stop while it runs and Edit after, each doing just that", () => {
    const stop = vi.fn();
    const edit = vi.fn();
    const decorate = withWebsitePrompt(() => null, { stop, edit });
    const running = render(<>{decorateAll(decorate, true)[0]!.before}</>);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(stop).toHaveBeenCalledTimes(1);
    running.unmount();
    render(<>{decorateAll(decorate, false)[0]!.before}</>);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(edit).toHaveBeenCalledWith("Build a booking site");
  });

  it("keeps a hidden message hidden", () => {
    const decorate = withWebsitePrompt(() => ({ hidden: true }), {
      stop: vi.fn(),
      edit: vi.fn(),
    });
    expect(decorateAll(decorate, false)[0]).toEqual({ hidden: true });
  });
});

describe("messageText", () => {
  it("joins the text parts, skipping the rest", () => {
    expect(
      messageText({
        id: "m",
        role: "user",
        parts: [
          { type: "text", content: "a " },
          { type: "image" } as never,
          { type: "text", content: "b " },
        ],
      } as UIMessage)
    ).toBe("a b");
  });
});
