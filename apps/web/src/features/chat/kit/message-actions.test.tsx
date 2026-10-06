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
import { HOVER_INTENT_MS, preferTraySide } from "./message-actions";
import { composeReply } from "./reply";

let current: Awaited<ReturnType<typeof renderRelay>> | null = null;
let afterRoot: (() => void) | null = null;
afterEach(async () => {
  await current?.cleanup();
  current = null;
  afterRoot?.();
  afterRoot = null;
  clearDraft("t-1");
  vi.unstubAllGlobals();
});
const original = {
  id: "a",
  role: "assistant" as const,
  parts: [{ type: "text" as const, content: "**Hello** there" }],
};
const second = {
  id: "b",
  role: "assistant" as const,
  parts: [{ type: "text" as const, content: "Second message" }],
};
const host = (id = "a") =>
  document.querySelector<HTMLElement>(`[data-message-target="${id}"]`)!;
/** The affordance: one positioned popup in the body, open while a message holds it. */
const popup = () =>
  document.querySelector<HTMLElement>('[data-slot="message-actions-popup"]');
/** Base UI's positioner wraps the popup; it carries the resolved side/align. */
const affordance = () => popup()?.parentElement ?? null;
const smiley = () => screen.getByRole("button", { name: "Add reaction" });
const chevron = (id = "a") =>
  within(host(id)).getByRole("button", { name: "Message menu" });
const reveal = async (id = "a") => {
  fireEvent.mouseEnter(host(id));
  await waitFor(() => expect(popup()?.hasAttribute("data-open")).toBe(true));
  await waitFor(() => expect(host(id).hasAttribute("data-active")).toBe(true));
};
/** The reaction tray, opened from the smiley. */
const tray = async () => {
  fireEvent.click(smiley());
  return screen.findByRole("toolbar", { name: "Message actions" });
};
/** The message menu, opened from the bubble's chevron. */
const menu = async (id = "a") => {
  fireEvent.click(chevron(id));
  return screen.findByRole("menu");
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

it("reveals the smiley and the corner chevron on hover and focus, copies from the menu, and hides with Escape", async () => {
  await mount();
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  expect(popup()).toBeNull();
  expect(chevron().hasAttribute("data-shown")).toBe(false);
  await reveal();
  // The smiley is positioned in the body, not inside the message.
  expect(host().contains(smiley())).toBe(false);
  expect(chevron().hasAttribute("data-shown")).toBe(true);
  fireEvent.click(
    within(await menu()).getByRole("menuitem", { name: "Copy message" })
  );
  expect(writeText).toHaveBeenCalledWith("**Hello** there");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  fireEvent.keyDown(host(), { key: "Escape" });
  await waitFor(() => expect(popup()).toBeNull());
  expect(chevron().hasAttribute("data-shown")).toBe(false);
  fireEvent.focus(host());
  await waitFor(() => expect(popup()?.hasAttribute("data-open")).toBe(true));
  vi.unstubAllGlobals();
});

it("waits for hover intent, then moves the same affordance to the next message at once", async () => {
  await mount(new FakeRelay({ history: [original, second] }));
  await screen.findByText("Second message");
  // A quick pass: in and out before the intent delay, nothing shows.
  fireEvent.mouseEnter(host());
  fireEvent.mouseLeave(host());
  await new Promise((resolve) => setTimeout(resolve, HOVER_INTENT_MS * 2));
  expect(popup()).toBeNull();
  await reveal();
  const element = affordance()!;
  expect(popup()!.hasAttribute("data-moving")).toBe(false);
  // Shown already: the next message takes it without the delay, and the
  // element is the same node (re-anchored, not remounted).
  fireEvent.mouseLeave(host());
  fireEvent.mouseEnter(host("b"));
  expect(host("b").hasAttribute("data-active")).toBe(true);
  expect(host().hasAttribute("data-active")).toBe(false);
  expect(affordance()).toBe(element);
  expect(popup()!.hasAttribute("data-moving")).toBe(true);
  expect(
    document.querySelectorAll('[data-slot="message-actions-popup"]')
  ).toHaveLength(1);
  // Leaving without entering another message hides it after the grace.
  fireEvent.mouseLeave(host("b"));
  await waitFor(() => expect(popup()).toBeNull());
});

it("anchors through the positioner: inner side of the bubble, centred", async () => {
  await mount(
    new FakeRelay({
      history: [
        original,
        {
          id: "u",
          role: "user" as const,
          parts: [{ type: "text" as const, content: "Hi friend" }],
        },
      ],
    })
  );
  await screen.findByText("Hi friend");
  await reveal();
  expect(affordance()!.dataset.side).toBe("inline-end");
  expect(affordance()!.dataset.align).toBe("center");
  fireEvent.mouseLeave(host());
  fireEvent.mouseEnter(host("u"));
  await waitFor(() => expect(affordance()!.dataset.side).toBe("inline-start"));
  expect(host("u").hasAttribute("data-active")).toBe(true);
});

it("places the tray above, below, or beside so it never covers a bubble", () => {
  const tray = { width: 300, height: 44 };
  const bubble = rect(300, 360);
  expect(preferTraySide(bubble, tray, "assistant")).toBe("top");
  // A centred date pill within the tray's span above: flip below.
  const pill = rect(250, 280, 280, 420);
  expect(preferTraySide(bubble, tray, "assistant", { above: pill })).toBe(
    "bottom"
  );
  // The same pill beside the tray's span: stay above. A user bubble's tray
  // starts at its left edge, an assistant's ends at its right edge.
  expect(
    preferTraySide(bubble, tray, "assistant", {
      above: rect(250, 280, 100, 190),
    })
  ).toBe("top");
  expect(
    preferTraySide(bubble, tray, "user", { above: rect(250, 280, 100, 190) })
  ).toBe("bottom");
  // A bot bubble 8 px under the previous one: below.
  expect(
    preferTraySide(bubble, tray, "assistant", { above: rect(200, 292) })
  ).toBe("bottom");
  // Rows on both sides: beside the smiley, never over either bubble.
  expect(
    preferTraySide(bubble, tray, "assistant", {
      above: pill,
      below: rect(372, 420),
    })
  ).toBe("side");
  // The viewport (less the composer dock) counts as an obstacle too: the
  // last message with no room below stays above; the first with no room
  // above goes below; squeezed between both, beside.
  const viewport = rect(0, 800, 0, 1000);
  expect(preferTraySide(rect(740, 790), tray, "assistant", { viewport })).toBe(
    "top"
  );
  expect(preferTraySide(rect(20, 80), tray, "assistant", { viewport })).toBe(
    "bottom"
  );
  expect(
    preferTraySide(rect(20, 80), tray, "assistant", {
      viewport,
      below: rect(92, 140),
    })
  ).toBe("side");
});

it("opens the tray below a bot bubble that sits 8 px under the previous one", async () => {
  await mount(new FakeRelay({ history: [original, second] }));
  await screen.findByText("Second message");
  const viewport = host().closest<HTMLElement>(
    '[data-slot="message-scroller-viewport"]'
  )!;
  viewport.getBoundingClientRect = () => rect(0, 800, 0, 1000);
  Object.defineProperty(viewport, "clientWidth", { value: 1000 });
  Object.defineProperty(viewport, "clientHeight", { value: 800 });
  const root = document.documentElement;
  const widths = Object.getOwnPropertyDescriptors(root);
  Object.defineProperty(root, "clientWidth", {
    value: 1000,
    configurable: true,
  });
  Object.defineProperty(root, "clientHeight", {
    value: 800,
    configurable: true,
  });
  afterRoot = () => {
    for (const key of ["clientWidth", "clientHeight"] as const)
      if (widths[key]) Object.defineProperty(root, key, widths[key]);
      else delete (root as unknown as Record<string, unknown>)[key];
  };
  host().getBoundingClientRect = () => rect(200, 292, 20, 400);
  host("b").querySelector<HTMLElement>(
    '[data-slot="message-anchor"]'
  )!.getBoundingClientRect = () => rect(300, 400, 20, 400);
  await reveal("b");
  const bar = await tray();
  expect(
    bar.closest<HTMLElement>('[data-slot="reaction-tray"]')!.dataset.prefer
  ).toBe("bottom");
  await waitFor(() =>
    expect(
      document.querySelector<HTMLElement>('[data-slot="reaction-tray"]')
        ?.parentElement?.dataset.side
    ).toBe("bottom")
  );
});

it("opens the tray below the first message of a day in the transcript", async () => {
  await mount(
    new FakeRelay({
      history: [
        {
          ...original,
          metadata: { tanstack: { createdAt: "2026-10-01T10:00:00Z" } },
        },
      ],
    })
  );
  const row = host().closest<HTMLElement>(
    '[data-slot="message-scroller-item"]'
  )!;
  const pill = row.previousElementSibling?.matches(
    '[data-slot="day-separator"]'
  )
    ? (row.previousElementSibling.firstElementChild as HTMLElement)
    : null;
  expect(pill).toBeTruthy();
  const viewport = host().closest<HTMLElement>(
    '[data-slot="message-scroller-viewport"]'
  )!;
  viewport.getBoundingClientRect = () => rect(0, 800, 0, 1000);
  // The positioner clips to the viewport's client box and the window's
  // (jsdom: 0×0, so every side would overflow and the flip picks "top").
  Object.defineProperty(viewport, "clientWidth", { value: 1000 });
  Object.defineProperty(viewport, "clientHeight", { value: 800 });
  const root = document.documentElement;
  const widths = Object.getOwnPropertyDescriptors(root);
  Object.defineProperty(root, "clientWidth", {
    value: 1000,
    configurable: true,
  });
  Object.defineProperty(root, "clientHeight", {
    value: 800,
    configurable: true,
  });
  afterRoot = () => {
    for (const key of ["clientWidth", "clientHeight"] as const)
      if (widths[key]) Object.defineProperty(root, key, widths[key]);
      else delete (root as unknown as Record<string, unknown>)[key];
  };
  // The affordance anchors to the hidden trigger covering the bubble.
  const anchor = host().querySelector<HTMLElement>(
    '[data-slot="message-anchor"]'
  )!;
  anchor.getBoundingClientRect = () => rect(100, 160, 20, 400);
  pill!.getBoundingClientRect = () => rect(60, 84, 180, 280);
  await reveal();
  const bar = await tray();
  // Our rule hands the primitive `side="bottom"`, and it keeps it.
  expect(
    bar.closest<HTMLElement>('[data-slot="reaction-tray"]')!.dataset.prefer
  ).toBe("bottom");
  await waitFor(() =>
    expect(
      document.querySelector<HTMLElement>('[data-slot="reaction-tray"]')
        ?.parentElement?.dataset.side
    ).toBe("bottom")
  );
});

it("hides while the transcript scrolls and returns on the next pointer move", async () => {
  await mount();
  const viewport = host().closest<HTMLElement>(
    '[data-slot="message-scroller-viewport"]'
  )!;
  await reveal();
  fireEvent.scroll(viewport);
  await waitFor(() =>
    expect(popup()?.hasAttribute("data-scrolling")).toBe(true)
  );
  fireEvent.pointerMove(host());
  await waitFor(() =>
    expect(popup()?.hasAttribute("data-scrolling")).toBe(false)
  );
});

it("lifts the hovered quick reaction and eases its neighbours aside, then Escape closes the tray before the affordance", async () => {
  await mount();
  await reveal();
  const bar = await tray();
  const quick = within(bar).getAllByRole("button", { name: /^React / });
  expect(quick).toHaveLength(6);
  fireEvent.pointerEnter(quick[1]!, { pointerType: "mouse" });
  expect(quick[1]!.dataset.lift).toBe("up");
  expect(quick[0]!.dataset.lift).toBe("left");
  expect(quick[2]!.dataset.lift).toBe("right");
  expect(quick[3]!.dataset.lift).toBeUndefined();
  fireEvent.pointerLeave(quick[1]!);
  expect(quick[1]!.dataset.lift).toBeUndefined();
  // Touch does not lift (no false hover on tap).
  fireEvent.pointerEnter(quick[1]!, { pointerType: "touch" });
  expect(quick[1]!.dataset.lift).toBeUndefined();
  fireEvent.keyDown(bar, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
  expect(popup()?.hasAttribute("data-open")).toBe(true);
  fireEvent.keyDown(smiley(), { key: "Escape" });
  await waitFor(() => expect(popup()).toBeNull());
});

it("toggles reactions through the transport and restores them on hydration", async () => {
  const relay = await mount();
  await reveal();
  const bar = await tray();
  fireEvent.click(within(bar).getByRole("button", { name: "React 👍" }));
  const pill = await screen.findByRole("button", {
    name: "Remove 👍 reaction",
  });
  expect(
    pill.closest('[data-slot="bubble-reactions"]')?.getAttribute("data-align")
  ).toBe("end");
  await waitFor(() =>
    expect(
      within(bar)
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

it("shows a reaction optimistically and rolls it back when main rejects it", async () => {
  const relay = new FakeRelay({ history: [original] });
  let release!: () => void;
  relay.faults.react = () => null;
  relay.source.react = async (input) => {
    relay.stats.react += 1;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    if (relay.stats.react === 1) throw new Error("rejected");
    relay.emit({
      type: "CUSTOM",
      name: "message.reactions",
      value: input,
      timestamp: Date.now(),
    } as never);
  };
  await mount(relay);
  await reveal();
  const bar = await tray();
  fireEvent.click(within(bar).getByRole("button", { name: "React 👍" }));
  // The pill and the pressed quick reaction appear before main answers.
  const pill = await screen.findByRole("button", {
    name: "Remove 👍 reaction",
  });
  expect(pill).toBeTruthy();
  expect(
    within(bar)
      .getByRole("button", { name: "React 👍" })
      .getAttribute("aria-pressed")
  ).toBe("true");
  await act(async () => release());
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Remove 👍 reaction" })
    ).toBeNull()
  );
  expect(within(host()).getByRole("alert").textContent).toBe(
    "Could not complete the action"
  );
  expect(
    (await relay.ai.hydrate({ threadId: relay.threadId })).messages[0]?.metadata
      ?.abacus?.reactions ?? []
  ).toEqual([]);
  // The next attempt sticks.
  fireEvent.click(within(bar).getByRole("button", { name: "React 👍" }));
  await screen.findByRole("button", { name: "Remove 👍 reaction" });
  await act(async () => release());
  await waitFor(() =>
    expect((relay.log.at(-1)!.event as { name?: string }).name).toBe(
      "message.reactions"
    )
  );
  expect(
    screen.getByRole("button", { name: "Remove 👍 reaction" })
  ).toBeTruthy();
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
  fireEvent.click(
    within(await menu()).getByRole("menuitem", { name: "Reply" })
  );
  expect(draftStore.state[relay.threadId]?.replyTo).toEqual({
    messageId: "a",
    role: "assistant",
    excerpt: "**Hello** there",
  });
  const field = screen.getByRole("textbox", { name: "Message Chief of Staff" });
  await waitFor(() => expect(document.activeElement).toBe(field));
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
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Cancel reply" })).toBeNull()
  );
});

it("cancels replies with Escape from the composer only, and composes attachments after the quote", async () => {
  await mount();
  await reveal();
  fireEvent.click(
    within(await menu()).getByRole("menuitem", { name: "Reply" })
  );
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

it("reveals on a phone tap and offers the complete reaction grid from the tray", async () => {
  await mount();
  const media = window.matchMedia;
  window.matchMedia = (query) => ({
    ...media(query),
    matches: query === "(max-width: 799px)",
  });
  try {
    fireEvent.click(host());
    await waitFor(() => expect(popup()?.hasAttribute("data-open")).toBe(true));
    const bar = await tray();
    fireEvent.click(
      within(bar).getByRole("button", { name: "More reactions" })
    );
    const cell = await screen.findByRole("button", { name: "React 🤔" });
    expect(cell.closest('[data-slot="message-actions"]')?.className).toContain(
      "grid-cols-8"
    );
    // A second tap puts it away.
    fireEvent.keyDown(cell, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
    fireEvent.click(host());
    await waitFor(() => expect(popup()).toBeNull());
  } finally {
    window.matchMedia = media;
  }
});

it("restores a reply preview after navigation and sends an attachment-only reply", async () => {
  const relay = await mount();
  await reveal();
  fireEvent.click(
    within(await menu()).getByRole("menuitem", { name: "Reply" })
  );
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
