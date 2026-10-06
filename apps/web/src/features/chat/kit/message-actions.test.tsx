import type { UserTextTags } from "@abacus-ai/contract/agent-types";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { draftStore, updateDraft, clearDraft } from "../composer/draft-store";
import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { renderRelay } from "../testing";
import { placeActionBar } from "./message-actions";
import { composeReply } from "./reply";

let current: Awaited<ReturnType<typeof renderRelay>> | null = null;
afterEach(async () => {
  await current?.cleanup();
  current = null;
  clearDraft("t-1");
  vi.unstubAllGlobals();
});
const original = {
  id: "a",
  role: "assistant" as const,
  parts: [{ type: "text" as const, content: "**Hello** there" }],
};
const host = () =>
  document.querySelector<HTMLElement>('[data-message-target="a"]')!;
/** The bar is an overlay in the body, mounted while the message wants it. */
const bar = () => screen.getByRole("toolbar");
const overlay = () =>
  bar().closest<HTMLElement>('[data-slot="message-actions-overlay"]')!;
const reveal = async () => {
  fireEvent.mouseEnter(host());
  await waitFor(() => expect(overlay().style.opacity).toBe("1"));
  return bar();
};
const mount = async (relay = new FakeRelay({ history: [original] })) => {
  relay.emitAll(b.sessionReady());
  current = await renderRelay(relay, "bot");
  await screen.findByText("there", { exact: false });
  return relay;
};
const rect = (top: number, bottom: number, left = 100, right = 500) =>
  ({
    top,
    bottom,
    left,
    right,
    width: right - left,
    height: bottom - top,
  }) as DOMRect;

it("reveals on hover and focus, hides with Escape, and copies markdown", async () => {
  await mount();
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  expect(screen.queryByRole("toolbar")).toBeNull();
  expect(host().parentElement!.contains(await reveal())).toBe(false);
  fireEvent.click(within(bar()).getByRole("button", { name: "Copy message" }));
  expect(writeText).toHaveBeenCalledWith("**Hello** there");
  fireEvent.keyDown(host(), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
  fireEvent.focus(host());
  await waitFor(() => expect(overlay().style.opacity).toBe("1"));
  vi.unstubAllGlobals();
});

it("sits above the bubble on its outer side and flips below at the viewport's top", () => {
  const viewport = rect(40, 800, 0, 1000);
  expect(
    placeActionBar(rect(300, 360), viewport, "assistant", 36, 1000)
  ).toEqual({ side: "above", top: 258, left: 100 });
  expect(placeActionBar(rect(300, 360), viewport, "user", 36, 1000)).toEqual({
    side: "above",
    top: 258,
    right: 500,
  });
  expect(
    placeActionBar(rect(60, 120), viewport, "assistant", 36, 1000)
  ).toEqual({ side: "below", top: 126, left: 100 });
});

it("hides while the transcript scrolls and returns on the next pointer move", async () => {
  await mount();
  const viewport = host().closest<HTMLElement>(
    '[data-slot="message-scroller-viewport"]'
  )!;
  await reveal();
  fireEvent.scroll(viewport);
  await waitFor(() => expect(overlay().style.opacity).toBe("0"));
  fireEvent.pointerMove(host());
  await waitFor(() => expect(overlay().style.opacity).toBe("1"));
});

it("toggles reactions through the transport and restores them on hydration", async () => {
  const relay = await mount();
  await reveal();
  fireEvent.click(within(bar()).getByRole("button", { name: "React 👍" }));
  const pill = await screen.findByRole("button", {
    name: "Remove 👍 reaction",
  });
  expect(
    pill.closest('[data-slot="bubble-reactions"]')?.getAttribute("data-align")
  ).toBe("end");
  await waitFor(() =>
    expect(
      within(bar())
        .getByRole("button", { name: "React 👍" })
        .getAttribute("aria-pressed")
    ).toBe("true")
  );
  expect(
    (await relay.ai.hydrate({ threadId: relay.threadId })).messages[0]?.metadata
      ?.abacus?.reactions
  ).toEqual(["👍"]);
  fireEvent.click(pill);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Remove 👍 reaction" })
    ).toBeNull()
  );
  expect(
    (await relay.ai.hydrate({ threadId: relay.threadId })).messages[0]?.metadata
      ?.abacus?.reactions
  ).toEqual([]);
});

it("keeps a reply draft, sends the attributed quote and renders only the user's words with a jump card", async () => {
  const relay = await mount(
    new FakeRelay({
      history: [original],
      onSend: (input, r) => {
        const message = input.messages[0]!;
        const text = message.parts
          .flatMap((part) => (part.type === "text" ? [part.content] : []))
          .join("");
        r.emitAll([
          b.runStarted(input.runId),
          ...b.text(message.id, "user", text, { metadata: message.metadata }),
          b.runFinished(input.runId),
        ]);
        return { runId: input.runId, status: "started" };
      },
    })
  );
  await reveal();
  fireEvent.click(within(bar()).getByRole("button", { name: "Reply" }));
  expect(draftStore.state[relay.threadId]?.replyTo).toEqual({
    messageId: "a",
    role: "assistant",
    excerpt: "**Hello** there",
  });
  const field = screen.getByRole("textbox", { name: "Message Chief of Staff" });
  expect(document.activeElement).toBe(field);
  // The preview lives inside the composer surface, above the text area.
  const preview = document.querySelector('[data-slot="reply-preview"]')!;
  expect(preview.parentElement).toBe(field.parentElement);
  expect(
    preview.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  fireEvent.change(field, { target: { value: "Thanks" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(relay.stats.send).toHaveLength(1));
  await screen.findByText("Thanks");
  const submitted = relay.stats.send[0]!.messages[0]!;
  expect(submitted.parts).toEqual([
    { type: "text", content: "> Assistant:\n> **Hello** there\n\nThanks" },
  ]);
  expect(
    (submitted.metadata as { abacus: { userText: UserTextTags } }).abacus
      .userText.visibleFrom
  ).toBe(32);
  const scroll = vi.fn();
  host().scrollIntoView = scroll;
  fireEvent.click(
    await screen.findByRole("button", { name: "Go to original message" })
  );
  await waitFor(() =>
    expect(scroll).toHaveBeenCalledWith({
      block: "center",
      behavior: "instant",
    })
  );
  expect(host().hasAttribute("data-highlighted")).toBe(true);
  expect(
    document.querySelector('[data-slot="reply-quote"][data-variant="bubble"]')
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Cancel reply" })).toBeNull();
});

it("cancels replies with Escape from the composer only, and composes attachments after the quote", async () => {
  await mount();
  await reveal();
  fireEvent.click(within(bar()).getByRole("button", { name: "Reply" }));
  const field = screen.getByRole("textbox", { name: "Message Chief of Staff" });
  // Escape elsewhere (the message, the document) leaves the reply alone.
  fireEvent.keyDown(host(), { key: "Escape" });
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.getByRole("button", { name: "Cancel reply" })).toBeTruthy();
  fireEvent.keyDown(field, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Cancel reply" })).toBeNull()
  );
  const replyTo = {
    messageId: "a",
    role: "assistant" as const,
    excerpt: "line one\nline two",
  };
  expect(composeReply("See this\n@/repo/file.txt", replyTo).text).toBe(
    "> Assistant:\n> line one\n> line two\n\nSee this\n@/repo/file.txt"
  );
  await act(async () => {
    updateDraft("t-1", (draft) => ({ ...draft, replyTo }));
  });
  expect(screen.getByRole("button", { name: "Cancel reply" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel reply" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Cancel reply" })).toBeNull()
  );
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "Message Chief of Staff" })
  );
});

it("reveals on a phone tap and offers the complete reaction grid", async () => {
  await mount();
  const media = window.matchMedia;
  window.matchMedia = (query) => ({
    ...media(query),
    matches: query === "(max-width: 799px)",
  });
  try {
    fireEvent.click(host());
    await waitFor(() => expect(overlay().style.opacity).toBe("1"));
    fireEvent.click(
      within(bar()).getByRole("button", { name: "More reactions" })
    );
    const cell = await screen.findByRole("button", { name: "React 🤔" });
    expect(cell.closest('[data-slot="reaction-grid"]')?.className).toContain(
      "grid-cols-8"
    );
  } finally {
    window.matchMedia = media;
  }
});

it("restores a reply preview after navigation and sends an attachment-only reply", async () => {
  const relay = await mount();
  await reveal();
  fireEvent.click(within(bar()).getByRole("button", { name: "Reply" }));
  await current!.cleanup();
  current = await renderRelay(relay, "bot");
  expect(
    await screen.findByRole("button", { name: "Cancel reply" })
  ).toBeTruthy();
  await act(async () =>
    updateDraft(relay.threadId, (draft) => ({
      ...draft,
      attachments: [
        {
          id: "file",
          name: "notes.txt",
          path: "/repo/notes.txt",
          state: "done",
        },
      ],
    }))
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(relay.stats.send).toHaveLength(1));
  expect(relay.stats.send[0]?.messages[0]?.parts).toEqual([
    {
      type: "text",
      content: "> Assistant:\n> **Hello** there\n\n@/repo/notes.txt",
    },
  ]);
  expect(
    screen.getByRole("button", { name: "Go to original message" })
  ).toBeTruthy();
});

it("jumps to an unmounted original without exceeding the transcript row budget", async () => {
  const history = Array.from({ length: 150 }, (_, index) => ({
    id: `original-${index}`,
    role: "assistant" as const,
    parts: [{ type: "text" as const, content: `Message ${index}` }],
  }));
  const relay = new FakeRelay({
    history: [
      ...history,
      {
        id: "reply",
        role: "user",
        parts: [{ type: "text", content: "Revisit this" }],
        metadata: {
          abacus: {
            userText: {
              replyTo: {
                messageId: "original-0",
                role: "assistant",
                excerpt: "Message 0",
              },
            },
          },
        },
      },
    ],
  });
  relay.emitAll(b.sessionReady());
  current = await renderRelay(relay, "bot");
  await screen.findByText("Revisit this");
  expect(
    document.querySelector('[data-message-target="original-0"]')
  ).toBeNull();
  const previous = HTMLElement.prototype.scrollIntoView;
  const scroll = vi.fn();
  HTMLElement.prototype.scrollIntoView = scroll;
  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Go to original message" })
    );
    await waitFor(() =>
      expect(
        document
          .querySelector('[data-message-target="original-0"]')
          ?.hasAttribute("data-highlighted")
      ).toBe(true)
    );
    expect(scroll).toHaveBeenCalled();
    expect(
      document.querySelectorAll(
        '[data-slot="message-scroller-item"][data-message-id]'
      ).length
    ).toBeLessThanOrEqual(100);
  } finally {
    HTMLElement.prototype.scrollIntoView = previous;
  }
});
