import { afterEach, describe, expect, it, vi } from "vitest";

import { captureUiContinuity, restoreUiContinuity } from "./ui-continuity";

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("capture", () => {
  it("records the focused field with its caret", () => {
    document.body.innerHTML = `<textarea id="composer">hello world</textarea>`;
    const field = document.querySelector("textarea")!;

    field.focus();
    field.setSelectionRange(2, 5);

    const snapshot = captureUiContinuity();

    expect(snapshot.focus).toEqual({
      selector: "#composer",
      selectionEnd: 5,
      selectionStart: 2,
    });
  });

  it("identifies elements without ids through stable attributes", () => {
    document.body.innerHTML = `<div><input name="search" /></div>`;
    document.querySelector("input")!.focus();

    expect(captureUiContinuity().focus?.selector).toBe('input[name="search"]');
  });

  it("prefers a stable attribute over a render-order-dependent id", () => {
    document.body.innerHTML = `<input id=":r5:" data-testid="model-search" />`;
    document.querySelector("input")!.focus();

    expect(captureUiContinuity().focus?.selector).toBe(
      'input[data-testid="model-search"]'
    );
  });

  it("never anchors on a generated id", () => {
    document.body.innerHTML = `<main><input id=":r5:" /></main>`;
    document.querySelector("input")!.focus();

    const selector = captureUiContinuity().focus?.selector;

    expect(selector).not.toContain(":r5:");
    expect(document.querySelector(selector!)).toBe(
      document.querySelector("input")
    );
  });

  it("captures a controlled input whose attribute mirrors its value", () => {
    // React writes the live value into the attribute on every render, so
    // value and defaultValue are always equal on a controlled input.
    document.body.innerHTML = `<input name="q" value="minmax" />`;
    const field = document.querySelector("input")!;

    expect(field.defaultValue).toBe(field.value);
    expect(captureUiContinuity().fields).toEqual([
      { selector: 'input[name="q"]', value: "minmax" },
    ]);
  });

  it("records scrolled containers", () => {
    document.body.innerHTML = `<div id="transcript"></div>`;
    document.querySelector("div")!.scrollTop = 120;

    expect(captureUiContinuity().scrolls).toEqual([
      { left: 0, selector: "#transcript", top: 120 },
    ]);
  });
});

describe("restore", () => {
  it("puts focus, caret, and scroll back", () => {
    document.body.innerHTML = `
      <div id="transcript"></div>
      <textarea id="composer">hello world</textarea>
    `;

    restoreUiContinuity({
      focus: { selector: "#composer", selectionEnd: 5, selectionStart: 2 },
      scrolls: [{ left: 0, selector: "#transcript", top: 120 }],
    });

    const field = document.querySelector("textarea")!;

    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(2);
    expect(field.selectionEnd).toBe(5);
    expect(document.querySelector("div")!.scrollTop).toBe(120);
  });

  it("keeps trying until the element mounts", () => {
    vi.useFakeTimers();
    restoreUiContinuity({ scrolls: [], focus: { selector: "#late" } });

    document.body.innerHTML = `<input id="late" />`;
    vi.advanceTimersByTime(300);

    expect(document.activeElement).toBe(document.querySelector("input"));
  });

  it("stands down once the user interacts", () => {
    vi.useFakeTimers();
    restoreUiContinuity({ scrolls: [], focus: { selector: "#late" } });

    window.dispatchEvent(new Event("keydown"));
    document.body.innerHTML = `<input id="late" />`;
    vi.advanceTimersByTime(1000);

    expect(document.activeElement).not.toBe(document.querySelector("input"));
  });

  it("skips what the new renderer no longer has", () => {
    vi.useFakeTimers();
    restoreUiContinuity({
      focus: { selector: "#gone" },
      scrolls: [{ left: 0, selector: "#also-gone", top: 50 }],
    });
    vi.advanceTimersByTime(10_000);
  });
});

describe("field values", () => {
  it("captures typed text but never passwords or empty fields", () => {
    document.body.innerHTML = `
      <input id="search" value="" />
      <input id="secret" type="password" />
      <input id="untouched" />
    `;
    const search = document.querySelector<HTMLInputElement>("#search")!;
    const secret = document.querySelector<HTMLInputElement>("#secret")!;

    search.value = "minmax";
    secret.value = "hunter2";

    expect(captureUiContinuity().fields).toEqual([
      { selector: "#search", value: "minmax" },
    ]);
  });

  it("restores into an empty field through an input event", async () => {
    document.body.innerHTML = `<input id="search" />`;
    const field = document.querySelector<HTMLInputElement>("#search")!;
    const events: string[] = [];

    field.addEventListener("input", () => events.push(field.value));
    await restoreUiContinuity({
      fields: [{ selector: "#search", value: "minmax" }],
      scrolls: [],
    });

    expect(field.value).toBe("minmax");
    expect(events).toEqual(["minmax"]);
  });

  it("leaves a field that already holds text alone", async () => {
    document.body.innerHTML = `<input id="search" />`;
    const field = document.querySelector<HTMLInputElement>("#search")!;

    field.value = "the durable draft";
    await restoreUiContinuity({
      fields: [{ selector: "#search", value: "stale" }],
      scrolls: [],
    });

    expect(field.value).toBe("the durable draft");
  });

  it("sets the value before placing the caret", async () => {
    document.body.innerHTML = `<textarea id="composer"></textarea>`;

    await restoreUiContinuity({
      fields: [{ selector: "#composer", value: "hello world" }],
      focus: { selector: "#composer", selectionEnd: 5, selectionStart: 2 },
      scrolls: [],
    });
    const field = document.querySelector("textarea")!;

    expect(field.value).toBe("hello world");
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(2);
    expect(field.selectionEnd).toBe(5);
  });
});
