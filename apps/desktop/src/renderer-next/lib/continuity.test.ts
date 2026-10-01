import { afterEach, expect, it, vi } from "vitest";

import { installActivity } from "./activity";
import { captureUiContinuity, restoreUiContinuity } from "./continuity";
import {
  captureDrafts,
  restoreDrafts,
  bindContinuityStore,
} from "./continuity/registry";
afterEach(() => {
  sessionStorage.clear();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const values = {
  name: " unfinished ",
  persona: "",
  instructions: "draft",
  description: "",
  model: null,
  look: { shape: "blob", color: "#4ade80", accessory: "none" },
  checkIn: {
    preset: "off",
    time: "",
    weekday: 1,
    custom: null,
    enabled: false,
  },
};
it("R7-T3: all typed draft families round-trip without normalization or attachment bytes", () => {
  const entries = {
    "abacus.chat.drafts": {
      t: {
        text: "hello",
        attachments: [
          {
            id: "staged-1",
            path: "/synthetic/staged.png",
            name: "image",
            state: "done",
            mimeType: "image/png",
          },
        ],
        mode: "PLAN",
        model: "m",
        pendingSubmit: {
          runId: "r",
          messageId: "u",
          parts: [{ type: "text", content: "hello" }],
          forwardedProps: { model: "m" },
        },
      },
    },
    "renderer-next:bot-draft": {
      id: "b",
      templateId: "template",
      values,
      stages: { bot: false, checkIn: "none" },
      lookPicked: true,
    },
    "abacus.bots.edits": {
      b: { values, baseline: { ...values, name: "old" } },
    },
    "abacus.sessions.start": {
      id: "draft",
      workspaceId: "w",
      worktree: { kind: "new", baseRef: "main" },
      worktreeOperationId: "op",
      stage: "checkout-ready",
      envelope: {
        runId: "r",
        messageId: "u",
        parts: [{ type: "text", content: "start" }],
      },
    },
    "abacus.sessions.tabs": {
      s: {
        tabs: [
          { ref: "terminal:t", title: "zsh", openedAt: 2, shell: "system" },
        ],
        last: "terminal:t",
        tree: {
          kind: "leaf",
          id: "p",
          tabs: ["terminal:t"],
          active: "terminal:t",
        },
      },
    },
    "abacus.sessions.reviews": { s: { file: "fingerprint" } },
    "routine-editor:r": [{ user: "change", reply: "done" }],
  };
  for (const [key, value] of Object.entries(entries))
    sessionStorage.setItem(key, JSON.stringify(value));
  const captured = captureDrafts();
  sessionStorage.clear();
  restoreDrafts(captured);
  for (const [key, value] of Object.entries(entries))
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(value);
});
it("invalid and unknown versioned stores are dropped and logged", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  restoreDrafts({
    "abacus.chat.drafts": { key: "chat.drafts.v1", value: { x: { text: 4 } } },
    unknown: { key: "v9", value: {} },
  });
  expect(sessionStorage.length).toBe(0);
  expect(warn).toHaveBeenCalledTimes(2);
});
it("captures live quota-blocked state and defers snapshots over 4 MB", () => {
  const unbind = bindContinuityStore("abacus.chat.drafts", {
    read: () => ({ t: { text: "x".repeat(4 * 1024 * 1024), attachments: [] } }),
    write: () => {},
  });
  try {
    expect(captureUiContinuity()).toEqual({ tooLarge: true });
  } finally {
    unbind();
  }
});
it("focus, selection and at most twenty anchored scroll viewports restore after hydration", async () => {
  document.body.innerHTML =
    '<textarea data-continuity-id="composer">draft text</textarea>' +
    Array.from(
      { length: 25 },
      (_, i) =>
        `<div data-continuity-scroll="s${i}"><div data-message-id="m${i}">message</div></div>`
    ).join("");
  const field = document.querySelector("textarea")!;
  field.focus();
  field.setSelectionRange(2, 6, "backward");
  const captured = captureUiContinuity();
  expect("tooLarge" in captured).toBe(false);
  if ("tooLarge" in captured) return;
  expect(captured.scrolls).toHaveLength(20);
  field.blur();
  field.setSelectionRange(0, 0);
  await restoreUiContinuity(captured);
  expect(document.activeElement).toBe(field);
  expect(field.selectionStart).toBe(2);
  expect(field.selectionEnd).toBe(6);
  expect(field.selectionDirection).toBe("backward");
});
it("activity is capture-phase, throttled at 5 s, and removable", () => {
  vi.useFakeTimers();
  const activity = vi.fn(async () => {});
  const remove = installActivity({ client: { window: { activity } } } as never);
  window.dispatchEvent(new Event("pointerdown"));
  window.dispatchEvent(new Event("wheel"));
  expect(activity).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(5000);
  window.dispatchEvent(new Event("keydown"));
  expect(activity).toHaveBeenCalledTimes(2);
  remove();
  vi.advanceTimersByTime(5000);
  window.dispatchEvent(new Event("keydown"));
  expect(activity).toHaveBeenCalledTimes(2);
});
