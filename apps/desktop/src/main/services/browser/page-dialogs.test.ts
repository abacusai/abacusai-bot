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
      'The page asked to confirm: "I am a JS Confirm". The browser answered Cancel; it never answers OK. If the user wants this confirmed, tell them: they confirm it themselves.',
    ]);
  });
});
