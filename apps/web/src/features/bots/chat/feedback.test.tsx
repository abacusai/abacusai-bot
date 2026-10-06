import type { TurnFeedbackOutcome } from "@abacus-ai/contract/contracts";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { renderWithDb } from "#renderer/features/chat/testing";

import { MessageFeedback } from "./feedback";

let current: Awaited<ReturnType<typeof renderWithDb>> | null = null;
afterEach(async () => {
  await current?.cleanup();
  current = null;
});

it("keeps sending, sent, comments and clear-on-second-click on the two direct buttons", async () => {
  let resolve!: (outcome: TurnFeedbackOutcome) => void;
  const send = vi.fn(
    () =>
      new Promise<TurnFeedbackOutcome>((done) => {
        resolve = done;
      })
  );
  current = await renderWithDb(<MessageFeedback send={send} />);
  fireEvent.click(screen.getByRole("button", { name: "Good response" }));
  expect(send).toHaveBeenLastCalledWith("up", undefined);
  const field = await screen.findByRole("textbox", { name: "Tell us more" });
  fireEvent.change(field, { target: { value: "  Useful answer  " } });
  expect(
    (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled
  ).toBe(true);
  await act(async () => resolve({ ok: true }));
  await screen.findByText("Thanks for the feedback");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(send).toHaveBeenLastCalledWith("up", "Useful answer");
  await act(async () => resolve({ ok: true }));
  fireEvent.click(screen.getByRole("button", { name: "Good response" }));
  expect(send).toHaveBeenLastCalledWith("clear", undefined);
});

it.each(["not-synced", "failed"] as const)(
  "shows %s feedback failures",
  async (reason) => {
    const send = vi.fn(async () => ({ ok: false as const, reason }));
    current = await renderWithDb(<MessageFeedback send={send} />);
    fireEvent.click(screen.getByRole("button", { name: "Bad response" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        reason === "not-synced"
          ? "Couldn't send feedback yet"
          : "Couldn't send your feedback. Please try again."
      )
    );
  }
);
