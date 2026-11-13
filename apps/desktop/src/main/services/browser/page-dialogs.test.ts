import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  DIALOG_ANSWERER,
  DIALOG_ACTING_MS,
  DIALOGS_ACTING,
  DIALOGS_TAKE,
  dialogLines,
} from "./page-dialogs";

/** A window with the page's own dialogs, and a clock the test moves. */
const pageWindow = () => {
  const own = {
    alert: vi.fn(),
    confirm: vi.fn(() => true),
    prompt: vi.fn(() => "typed"),
  };
  let now = 1_000;
  const window: Record<string, unknown> = { ...own };
  window.window = window;
  window.Date = { now: () => now };
  window.Object = Object;
  window.String = String;
  const run = (script: string): unknown => runInNewContext(script, window);
  run(DIALOG_ANSWERER);
  return { window, own, run, later: (ms: number) => (now += ms) };
};

describe("a page's dialogs while the bot acts", () => {
  it("answers them Cancel during an action and keeps what they asked", () => {
    const page = pageWindow();
    page.run(DIALOGS_ACTING);
    expect(page.run('confirm("Delete it?")')).toBe(false);
    expect(page.run('prompt("Your name?")')).toBeNull();
    expect(page.run('alert("Saved")')).toBeUndefined();
    expect(page.own.confirm).not.toHaveBeenCalled();
    expect(page.run(DIALOGS_TAKE)).toEqual([
      { kind: "confirm", message: "Delete it?" },
      { kind: "prompt", message: "Your name?" },
      { kind: "alert", message: "Saved" },
    ]);
    // Read once, and the answerer is let go with the read.
    expect(page.run(DIALOGS_TAKE)).toEqual([]);
    expect(page.run('confirm("Again?")')).toBe(true);
  });

  it("leaves a dialog outside a bot's action to the page, as the user sees it", () => {
    const page = pageWindow();
    expect(page.run('confirm("Mine?")')).toBe(true);
    page.run(DIALOGS_ACTING);
    page.later(DIALOG_ACTING_MS);
    expect(page.run('confirm("Later?")')).toBe(true);
    expect(page.own.confirm).toHaveBeenCalledTimes(2);
    expect(page.run(DIALOGS_TAKE)).toEqual([]);
  });

  it("installs once, however often it is sent", () => {
    const page = pageWindow();
    page.run(DIALOG_ANSWERER);
    page.run(DIALOGS_ACTING);
    page.run('confirm("Once?")');
    expect(page.run(DIALOGS_TAKE)).toHaveLength(1);
  });

  it("tells the bot what the page asked and that it never answers OK", () => {
    expect(
      dialogLines([{ kind: "confirm", message: "I am a JS Confirm" }])
    ).toEqual([
      'The page asked to confirm: "I am a JS Confirm". The browser answered Cancel; it never answers OK, and the user cannot answer it in the Browser pane either. If they want it confirmed, tell them to do this step on the site in their own browser.',
    ]);
  });

  it("never sends the user to the Browser pane for a prompt it cancelled", () => {
    // The built-in browser cancels a page's own dialogs for the user too.
    const [line] = dialogLines([{ kind: "prompt", message: "Name?" }]);
    expect(line).toContain("do this step on the site in their own browser");
  });

  it("in the user's own browser, sends them to that tab, never to a pane", () => {
    // In Chrome mode there is no Browser pane, and outside a bot's action the
    // page's own dialog shows there, so the user can answer it themselves.
    const [line] = dialogLines([{ kind: "confirm", message: "Sure?" }], {
      inApp: false,
    });
    expect(line).not.toMatch(/pane/i);
    expect(line).toContain(
      "they can answer it themselves in that tab of their browser"
    );
  });
});
