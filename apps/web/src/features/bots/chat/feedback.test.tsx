import type { TurnFeedbackOutcome } from "@abacus-ai/contract/contracts";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { MessageFeedback as BaseFeedback } from "#renderer/components/message-feedback";
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

const placeholder = (): string | null =>
  screen
    .getByRole("textbox", { name: "Tell us more" })
    .getAttribute("placeholder");
const pressed = (name: string): string | null =>
  screen.getByRole("button", { name }).getAttribute("aria-pressed");

it("asks a question that matches the pressed thumb", async () => {
  const send = vi.fn(async () => ({ ok: true as const }));
  current = await renderWithDb(<MessageFeedback send={send} />);
  fireEvent.click(screen.getByRole("button", { name: "Good response" }));
  await screen.findByText("Thanks for the feedback");
  expect(placeholder()).toBe("What did you like?");
  fireEvent.click(screen.getByRole("button", { name: "Bad response" }));
  await waitFor(() => expect(pressed("Bad response")).toBe("true"));
  expect(pressed("Good response")).toBe("false");
  expect(placeholder()).toBe("What went wrong?");
  expect(send).toHaveBeenLastCalledWith("down", undefined);
});

it("says the comment reaches the chat's agent, by name when it has one, and only where it does", async () => {
  const send = vi.fn(async () => ({ ok: true as const }));
  current = await renderWithDb(
    <MessageFeedback reader={{ name: "Juno" }} send={send} />
  );
  fireEvent.click(screen.getByRole("button", { name: "Bad response" }));
  await screen.findByText("Thanks for the feedback");
  expect(placeholder()).toBe("Tell Juno what to change…");
  expect(
    screen.getByText(
      "Juno reads this and replies in the chat. Our team sees it too."
    )
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Good response" }));
  await waitFor(() => expect(pressed("Good response")).toBe("true"));
  expect(placeholder()).toBe("Tell Juno what you liked…");
  await current.cleanup();

  current = await renderWithDb(<MessageFeedback reader={{}} send={send} />);
  fireEvent.click(screen.getByRole("button", { name: "Bad response" }));
  await screen.findByText("Thanks for the feedback");
  expect(placeholder()).toBe("Tell the agent what to change…");
  expect(
    screen.getByText(
      "The agent reads this and replies in the chat. Our team sees it too."
    )
  ).toBeTruthy();
  await current.cleanup();

  // A chat nobody steers from here (another person's, a routine run): the team's copy.
  current = await renderWithDb(<MessageFeedback send={send} />);
  fireEvent.click(screen.getByRole("button", { name: "Bad response" }));
  await screen.findByText("Thanks for the feedback");
  expect(placeholder()).toBe("What went wrong?");
  expect(screen.queryByText(/replies in the chat/)).toBeNull();
});

it("keeps a failed rating pressed with its comment, and retries it rather than clearing", async () => {
  const send = vi
    .fn<(rating: string, comment?: string) => Promise<TurnFeedbackOutcome>>()
    .mockResolvedValueOnce({ ok: false, reason: "failed" })
    .mockResolvedValueOnce({ ok: false, reason: "failed" })
    .mockResolvedValue({ ok: true });
  current = await renderWithDb(<MessageFeedback send={send} />);
  fireEvent.click(screen.getByRole("button", { name: "Good response" }));
  await screen.findByText("Couldn't send your feedback. Please try again.");
  expect(pressed("Good response")).toBe("true");
  expect(placeholder()).toBe("What did you like?");
  // An empty comment still retries a failed send.
  const submit = screen.getByRole("button", {
    name: "Send",
  }) as HTMLButtonElement;
  expect(submit.disabled).toBe(false);
  fireEvent.change(screen.getByRole("textbox", { name: "Tell us more" }), {
    target: { value: "Quick and right" },
  });
  fireEvent.click(submit);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send).toHaveBeenLastCalledWith("up", "Quick and right");
  await screen.findByText("Couldn't send your feedback. Please try again.");
  expect(
    (
      screen.getByRole("textbox", {
        name: "Tell us more",
      }) as HTMLTextAreaElement
    ).value
  ).toBe("Quick and right");
  // The thumb again: the server holds nothing, so it sends the rating again.
  fireEvent.click(screen.getByRole("button", { name: "Good response" }));
  await screen.findByText("Thanks for the feedback");
  expect(send).toHaveBeenLastCalledWith("up", "Quick and right");
  expect(pressed("Good response")).toBe("true");
});

it("puts the held rating back when clearing it fails", async () => {
  const send = vi
    .fn<(rating: string, comment?: string) => Promise<TurnFeedbackOutcome>>()
    .mockResolvedValueOnce({ ok: true })
    .mockResolvedValueOnce({ ok: false, reason: "failed" })
    .mockResolvedValue({ ok: true });
  current = await renderWithDb(<MessageFeedback send={send} />);
  fireEvent.click(screen.getByRole("button", { name: "Bad response" }));
  await screen.findByText("Thanks for the feedback");
  // The same thumb again also closes its popover, so this reads the thumb,
  // not the form and status line inside a popover that is going away.
  fireEvent.click(screen.getByRole("button", { name: "Bad response" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Bad response" })
        .getAttribute("data-status")
    ).toBe("failed")
  );
  expect(send).toHaveBeenLastCalledWith("clear", undefined);
  expect(pressed("Bad response")).toBe("true");
  // Still held, so the next click clears again.
  fireEvent.click(screen.getByRole("button", { name: "Bad response" }));
  await waitFor(() => expect(pressed("Bad response")).toBe("false"));
  expect(send).toHaveBeenLastCalledWith("clear", undefined);
});

it("a note past the inline bound is saved as pasted text: the agent gets its file, the team its words, the box says so", async () => {
  const send = vi.fn(async () => ({ ok: true as const }));
  const saveLong = vi.fn(
    async () => "/repo/.abacusai-bot/temp/pasted-text-note-1.txt"
  );
  current = await renderWithDb(
    <BaseFeedback send={send} saveLong={saveLong} reader={{ name: "Ada" }} />
  );
  fireEvent.click(screen.getByRole("button", { name: "Bad response" }));
  const box = await screen.findByRole("textbox", { name: "Tell us more" });
  const note = "x".repeat(100_001);
  fireEvent.change(box, { target: { value: note } });
  await act(async () => {});
  expect(
    document.querySelector('[data-slot="feedback-as-file"]')?.textContent
  ).toBe("Long text goes in as a pasted-text file, read in full.");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(send).toHaveBeenLastCalledWith(
      "down",
      note,
      "/repo/.abacusai-bot/temp/pasted-text-note-1.txt"
    )
  );
  expect(saveLong).toHaveBeenCalledWith(note);
});
